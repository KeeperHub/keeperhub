import type { LookupAddress } from "node:dns";
import { createServer, type Server, type Socket } from "node:net";
import postgres from "postgres";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { mockLookup } = vi.hoisted(() => ({ mockLookup: vi.fn() }));

vi.mock("node:dns", () => ({
  promises: { lookup: mockLookup },
}));

// Loopback is the only address a unit test can really connect to. Treat it
// as public here so the allowed path reaches a local server; every other
// address keeps the real verdict.
vi.mock("@/lib/safe-fetch", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/safe-fetch")>();
  return {
    ...real,
    isBlockedIp: (ip: string) =>
      ip === "127.0.0.1" ? { blocked: false } : real.isBlockedIp(ip),
  };
});

import {
  assertConnectionUrlIsPublic,
  connectToPublicHost,
  createPublicOnlySocketFactory,
  publicOnlyLookup,
  withPublicOnlySocket,
} from "@/lib/db/connection-host-guard";
import {
  getDatabaseErrorMessage,
  HOST_NOT_ALLOWED_CODE,
  HOST_NOT_ALLOWED_MESSAGE,
} from "@/lib/db/connection-utils";

const PUBLIC: LookupAddress[] = [{ address: "93.184.216.34", family: 4 }];
const PRIVATE: LookupAddress[] = [{ address: "10.0.0.5", family: 4 }];
const LOOPBACK_AS_PUBLIC: LookupAddress[] = [
  { address: "127.0.0.1", family: 4 },
];

type LocalServer = {
  port: number;
  connections: () => number;
  firstChunk: Promise<Buffer>;
  close: () => Promise<void>;
};

const servers: LocalServer[] = [];

async function startLocalServer(): Promise<LocalServer> {
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

function lookupResult(
  options: { all?: boolean },
  addresses: LookupAddress[] | Error
): Promise<{ error: unknown; address: unknown; family: unknown }> {
  if (addresses instanceof Error) {
    mockLookup.mockRejectedValueOnce(addresses);
  } else {
    mockLookup.mockResolvedValueOnce(addresses);
  }
  return new Promise((resolve) => {
    publicOnlyLookup("db.example", options, (error, address, family) => {
      resolve({ error, address, family });
    });
  });
}

beforeEach(() => {
  mockLookup.mockReset();
});

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.close();
  }
});

describe("publicOnlyLookup", () => {
  it("returns every address when the caller asks for all", async () => {
    const result = await lookupResult({ all: true }, PUBLIC);
    expect(result.error).toBeNull();
    expect(result.address).toEqual(PUBLIC);
    expect(mockLookup).toHaveBeenCalledWith("db.example", { all: true });
  });

  it("returns the first address and family for a single lookup", async () => {
    const result = await lookupResult({}, PUBLIC);
    expect(result.error).toBeNull();
    expect(result.address).toBe("93.184.216.34");
    expect(result.family).toBe(4);
  });

  it("refuses an answer with a private address", async () => {
    const result = await lookupResult({ all: true }, PRIVATE);
    expect(result.error).toMatchObject({
      code: HOST_NOT_ALLOWED_CODE,
      message: HOST_NOT_ALLOWED_MESSAGE,
    });
  });

  it("refuses an answer that mixes public and private addresses", async () => {
    const result = await lookupResult({ all: true }, [...PUBLIC, ...PRIVATE]);
    expect(result.error).toMatchObject({ code: HOST_NOT_ALLOWED_CODE });
  });

  it("refuses an empty answer", async () => {
    const result = await lookupResult({ all: true }, []);
    expect(result.error).toMatchObject({ code: HOST_NOT_ALLOWED_CODE });
  });

  it("passes a DNS failure through unchanged", async () => {
    const dnsError = Object.assign(new Error("getaddrinfo ENOTFOUND"), {
      code: "ENOTFOUND",
    });
    const result = await lookupResult({ all: true }, dnsError);
    expect(result.error).toBe(dnsError);
  });
});

describe("connectToPublicHost", () => {
  it("connects when the socket's own lookup returns a public address", async () => {
    const server = await startLocalServer();
    mockLookup.mockResolvedValue(LOOPBACK_AS_PUBLIC);

    const socket = await connectToPublicHost("db.example", server.port, 2000);

    expect(socket.remoteAddress).toBe("127.0.0.1");
    // postgres.js reads socket.host for the TLS servername.
    expect((socket as Socket & { host?: string }).host).toBe("db.example");
    socket.destroy();
  });

  it("refuses a rebinding answer that passed the early check", async () => {
    const server = await startLocalServer();
    // First answer (early check) is public, second answer (the connect) is not.
    mockLookup.mockResolvedValueOnce(PUBLIC).mockResolvedValueOnce(PRIVATE);

    await expect(
      assertConnectionUrlIsPublic(`postgres://u:p@db.example:${server.port}/db`)
    ).resolves.toBeUndefined();
    await expect(
      connectToPublicHost("db.example", server.port, 2000)
    ).rejects.toMatchObject({ code: HOST_NOT_ALLOWED_CODE });

    expect(mockLookup).toHaveBeenCalledTimes(2);
    expect(server.connections()).toBe(0);
  });

  it.each([
    ["private IPv4 literal", "10.0.0.5"],
    ["link-local literal", "169.254.169.254"],
    ["bracketed IPv6 loopback", "[::1]"],
    ["blocked hostname", "localhost"],
  ])("refuses a %s without a DNS lookup", async (_label, host) => {
    await expect(connectToPublicHost(host, 5432, 2000)).rejects.toMatchObject({
      code: HOST_NOT_ALLOWED_CODE,
    });
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("rejects a missing host", async () => {
    await expect(connectToPublicHost(undefined, 5432, 2000)).rejects.toThrow(
      "Connection string is missing a host"
    );
  });

  it("times out with CONNECT_TIMEOUT when the connect does not finish", async () => {
    mockLookup.mockReturnValue(new Promise<never>(() => undefined));

    await expect(
      connectToPublicHost("db.example", 5432, 50)
    ).rejects.toMatchObject({ code: "CONNECT_TIMEOUT" });
  });

  it("uses the first host and port from the driver's target", async () => {
    const server = await startLocalServer();
    mockLookup.mockResolvedValue(LOOPBACK_AS_PUBLIC);
    const factory = createPublicOnlySocketFactory(2);

    const socket = await factory({
      host: ["db.example", "other.example"],
      port: [server.port, 1],
    });

    expect(socket.remotePort).toBe(server.port);
    expect(mockLookup).toHaveBeenCalledTimes(1);
    socket.destroy();
  });
});

describe("postgres.js with withPublicOnlySocket", () => {
  it("adds a socket factory and keeps the other options", () => {
    const options = withPublicOnlySocket({ max: 1, connect_timeout: 5 });
    expect(options).toMatchObject({ max: 1, connect_timeout: 5 });
    expect(typeof (options as { socket?: unknown }).socket).toBe("function");
  });

  it("fails the query with the not-allowed message on a rebinding answer", async () => {
    const server = await startLocalServer();
    mockLookup.mockResolvedValue(PRIVATE);
    const sql = postgres(
      `postgres://u:p@db.example:${server.port}/db`,
      withPublicOnlySocket({ max: 1, connect_timeout: 2, ssl: false })
    );

    const error = await sql`SELECT 1`.then(
      () => null,
      (queryError: unknown) => queryError
    );
    await sql.end({ timeout: 0 });

    expect(getDatabaseErrorMessage(error)).toBe(HOST_NOT_ALLOWED_MESSAGE);
    expect(server.connections()).toBe(0);
  });

  it("sends the startup message through the checked socket", async () => {
    const server = await startLocalServer();
    mockLookup.mockResolvedValue(LOOPBACK_AS_PUBLIC);
    const sql = postgres(
      `postgres://u:p@db.example:${server.port}/db`,
      withPublicOnlySocket({ max: 1, connect_timeout: 2, ssl: false })
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
