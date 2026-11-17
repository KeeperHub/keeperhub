import { createServer, type Server, type Socket } from "node:net";
import postgres from "postgres";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { fakeDns } = vi.hoisted(() => ({
  fakeDns: new Map<
    string,
    { addresses: { address: string; family: number }[]; delayMs?: number }
  >(),
}));

// Callback-form `lookup` (used by safe-fetch's `validatingLookup`) answers
// from `fakeDns`, optionally after a delay. A name registered with an empty
// list never answers, to model a resolver that hangs. No test touches real DNS.
vi.mock("node:dns", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns")>();
  function lookup(
    hostname: string,
    options: { all?: boolean },
    callback: (...args: unknown[]) => void
  ): void {
    const entry = fakeDns.get(hostname);
    if (entry && entry.addresses.length === 0) {
      return;
    }
    setTimeout(() => {
      if (!entry) {
        callback(
          Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), {
            code: "ENOTFOUND",
          }),
          []
        );
        return;
      }
      const [first] = entry.addresses;
      if (options.all) {
        callback(null, entry.addresses);
        return;
      }
      callback(null, first?.address, first?.family);
    }, entry?.delayMs ?? 0);
  }
  return { ...actual, lookup };
});

import { withPublicOnlySocket } from "@/lib/db/connection-host-guard";
import {
  getDatabaseErrorMessage,
  HOST_NOT_ALLOWED_MESSAGE,
} from "@/lib/db/connection-utils";

const PLUGIN = "database-query";
const LOOPBACK = [{ address: "127.0.0.1", family: 4 }];

type LocalServer = {
  port: number;
  connections: () => number;
  firstChunk: Promise<Buffer>;
  close: () => Promise<void>;
};

const servers: LocalServer[] = [];

// A server that accepts and reads, but never answers the startup message.
async function startSilentServer(): Promise<LocalServer> {
  let count = 0;
  let resolveChunk: (chunk: Buffer) => void = () => undefined;
  const firstChunk = new Promise<Buffer>((resolve) => {
    resolveChunk = resolve;
  });
  const sockets: Socket[] = [];
  const server: Server = createServer((socket) => {
    count += 1;
    sockets.push(socket);
    socket.once("data", (chunk: Buffer) => resolveChunk(chunk));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("local server has no port");
  }
  const local: LocalServer = {
    port: address.port,
    connections: () => count,
    firstChunk,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
  servers.push(local);
  return local;
}

async function runQuery(
  host: string,
  port: number,
  connectTimeoutSeconds: number
): Promise<{ error: unknown; elapsedMs: number }> {
  const sql = postgres(
    `postgres://u:p@${host}:${port}/db`,
    withPublicOnlySocket(
      { max: 1, connect_timeout: connectTimeoutSeconds, ssl: false },
      PLUGIN
    )
  );
  const started = Date.now();
  const error = await sql`SELECT 1`.then(
    () => null,
    (queryError: unknown) => queryError
  );
  const elapsedMs = Date.now() - started;
  await sql.end({ timeout: 0 });
  return { error, elapsedMs };
}

beforeEach(() => {
  fakeDns.clear();
  vi.unstubAllEnvs();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  while (servers.length > 0) {
    await servers.pop()?.close();
  }
});

describe("postgres.js with the public-only socket", () => {
  it("fails the query with the not-allowed message when DNS answers a private address", async () => {
    const server = await startSilentServer();
    fakeDns.set("db.example", {
      addresses: [{ address: "10.0.0.5", family: 4 }],
    });

    const { error, elapsedMs } = await runQuery("db.example", server.port, 5);

    expect(getDatabaseErrorMessage(error)).toBe(HOST_NOT_ALLOWED_MESSAGE);
    expect(elapsedMs).toBeLessThan(1000);
    expect(server.connections()).toBe(0);
  });

  it("refuses loopback through DNS when shadow mode is off", async () => {
    const server = await startSilentServer();
    fakeDns.set("db.example", { addresses: LOOPBACK });

    const { error } = await runQuery("db.example", server.port, 5);

    expect(getDatabaseErrorMessage(error)).toBe(HOST_NOT_ALLOWED_MESSAGE);
    expect(server.connections()).toBe(0);
  });

  it("times out with CONNECT_TIMEOUT within connect_timeout when DNS never answers", async () => {
    fakeDns.set("hang.example", { addresses: [] });

    const { error, elapsedMs } = await runQuery("hang.example", 5432, 1);

    expect(error).toMatchObject({ code: "CONNECT_TIMEOUT" });
    expect(elapsedMs).toBeLessThan(1500);
  });

  it("spends one connect_timeout budget across DNS, TCP and startup", async () => {
    vi.stubEnv("SAFE_FETCH_SHADOW", "true");
    const server = await startSilentServer();
    // DNS takes most of the budget, then the server never answers startup.
    fakeDns.set("slow.example", { addresses: LOOPBACK, delayMs: 700 });

    const { error, elapsedMs } = await runQuery("slow.example", server.port, 1);

    expect(error).toMatchObject({ code: "CONNECT_TIMEOUT" });
    expect(server.connections()).toBe(1);
    expect(elapsedMs).toBeLessThan(1500);
  });

  it("sends the startup message through the checked socket (shadow mode allows loopback)", async () => {
    vi.stubEnv("SAFE_FETCH_SHADOW", "true");
    const server = await startSilentServer();
    fakeDns.set("db.example", { addresses: LOOPBACK });
    const sql = postgres(
      `postgres://u:p@db.example:${server.port}/db`,
      withPublicOnlySocket({ max: 1, connect_timeout: 2, ssl: false }, PLUGIN)
    );

    const pending = sql`SELECT 1`.catch(() => null);
    const chunk = await server.firstChunk;
    await sql.end({ timeout: 0 });
    await pending;

    // Startup message: int32 length, then protocol version 3.0.
    expect(chunk.readInt32BE(4)).toBe(196_608);
    expect(server.connections()).toBe(1);
  });
});
