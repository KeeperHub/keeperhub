import type { Socket } from "node:net";
import postgres from "postgres";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { fakeDns, lookupCalls, mockSecurityEvent, incrementCounter } =
  vi.hoisted(() => ({
    fakeDns: new Map<string, { address: string; family: number }[]>(),
    lookupCalls: [] as string[],
    mockSecurityEvent: vi.fn(),
    incrementCounter: vi.fn(),
  }));

// The callback-form `lookup` (used by safe-fetch's `validatingLookup`) answers
// from `fakeDns` on a later tick, as the real resolver does, and fails with
// ENOTFOUND for any other name. No test touches real DNS.
vi.mock("node:dns", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns")>();
  function lookup(
    hostname: string,
    options: { all?: boolean },
    callback: (...args: unknown[]) => void
  ): void {
    lookupCalls.push(hostname);
    const addresses = fakeDns.get(hostname);
    setImmediate(() => {
      if (!addresses) {
        callback(
          Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), {
            code: "ENOTFOUND",
          }),
          []
        );
        return;
      }
      if (options.all) {
        callback(null, addresses);
        return;
      }
      callback(null, addresses[0]?.address, addresses[0]?.family);
    });
  }
  return { ...actual, lookup };
});

vi.mock("@/lib/metrics", () => ({
  getMetricsCollector: () => ({
    incrementCounter,
    recordLatency: vi.fn(),
    recordError: vi.fn(),
    setGauge: vi.fn(),
  }),
}));

vi.mock("@/lib/logging", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/logging")>()),
  logSecurityEvent: mockSecurityEvent,
}));

import {
  assertSinglePostgresHost,
  createPublicOnlySocketFactory,
  withPublicOnlySocket,
} from "@/lib/db/connection-host-guard";
import { HOST_NOT_ALLOWED_MESSAGE } from "@/lib/db/connection-utils";

const MISSING_HOST = "Connection string is missing a host";
const PLUGIN = "database-query";

function socketError(socket: Socket): Promise<NodeJS.ErrnoException> {
  return new Promise((resolve) => {
    socket.once("error", resolve);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  fakeDns.clear();
  lookupCalls.length = 0;
});

describe("assertSinglePostgresHost", () => {
  it.each([
    ["hostname with port", "postgres://u:p@db.example.com:5432/db"],
    ["encoded @ in the password", "postgres://u:p%40x@db.example.com/db"],
    ["IPv4 literal with query", "postgresql://u:p@1.1.1.1/db?sslmode=require"],
  ])("accepts a single host: %s", (_label, url) => {
    expect(() => assertSinglePostgresHost(url)).not.toThrow();
  });

  it.each([
    [
      "percent-encoded comma",
      "postgres://u:p@10.0.0.5%2Cx.attacker.example/db",
    ],
    [
      "lower-case encoded comma",
      "postgres://u:p@10.0.0.5%2cx.attacker.example/db",
    ],
    ["plain comma", "postgres://u:p@a.example,b.example:5433/db"],
  ])("rejects more than one host: %s", (_label, url) => {
    expect(() => assertSinglePostgresHost(url)).toThrow(
      HOST_NOT_ALLOWED_MESSAGE
    );
  });

  it.each([
    ["empty string", ""],
    ["plain garbage", "not-a-url"],
    ["scheme only", "postgres://"],
    ["empty host", "postgres://u:p@/db"],
    ["malformed percent escape", "postgres://u:p@db%zz.example/db"],
  ])("rejects a missing or unparseable host: %s", (_label, url) => {
    expect(() => assertSinglePostgresHost(url)).toThrow(MISSING_HOST);
  });

  it.each([
    "postgres://u:p@db.example.com:5432/db",
    "postgres://u:p@10.0.0.5%2Cx.attacker.example/db",
    "postgres://u:p@a.example,b.example:5433/db",
    "postgres://u:p%40x@db.example.com/db",
    "postgres://u:p%2C@db.example.com/db",
  ])("agrees with postgres.js on how many hosts %s names", async (url) => {
    const sql = postgres(url, { max: 1 });
    const postgresSeesSeveral = sql.options.host.length > 1;
    await sql.end();

    let rejected = false;
    try {
      assertSinglePostgresHost(url);
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(postgresSeesSeveral);
  });

  it("never echoes the connection string", () => {
    const url =
      "postgres://supersecretuser:supersecretpassword@10.0.0.1%2Cinternal.example/db";
    expect(() => assertSinglePostgresHost(url)).toThrow(
      HOST_NOT_ALLOWED_MESSAGE
    );
    try {
      assertSinglePostgresHost(url);
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain("supersecret");
      expect(message).not.toContain("10.0.0.1");
      expect(message).not.toContain("internal");
    }
  });
});

describe("createPublicOnlySocketFactory", () => {
  it.each([
    ["IPv4 loopback", "127.0.0.1"],
    ["IPv4 private 10/8", "10.0.0.1"],
    ["IPv4 private 192.168/16", "192.168.1.1"],
    ["IPv4 IMDS link-local", "169.254.169.254"],
    ["IPv6 loopback (bracketed)", "[::1]"],
    ["IPv6 ULA", "fc00::1"],
    ["IPv6 site-local NAT64", "64:ff9b:1::1"],
    ["IPv4-mapped IPv6 to private", "::ffff:127.0.0.1"],
  ])("refuses the literal %s without a DNS lookup", async (_label, host) => {
    const factory = createPublicOnlySocketFactory(PLUGIN);

    await expect(factory({ host: [host], port: [5432] })).rejects.toMatchObject(
      { code: "SSRF_BLOCKED" }
    );
    expect(lookupCalls).toHaveLength(0);
  });

  it.each([
    ["localhost", "localhost"],
    ["upper-case localhost", "LOCALHOST"],
    ["trailing-dot localhost", "localhost."],
    ["mDNS .local suffix", "raspberrypi.local"],
    [".internal suffix", "service.internal"],
    ["EC2 VPC internal hostname", "ip-10-0-0-5.us-east-2.compute.internal"],
    ["k8s service DNS", "keeperhub-common.keeperhub.svc.cluster.local"],
  ])("refuses the hostname %s without a DNS lookup", async (_label, host) => {
    const factory = createPublicOnlySocketFactory(PLUGIN);

    await expect(factory({ host: [host], port: [5432] })).rejects.toMatchObject(
      { code: "SSRF_BLOCKED" }
    );
    expect(lookupCalls).toHaveLength(0);
  });

  it("refuses a hostname whose DNS answer is private, at connect time", async () => {
    fakeDns.set("db.example", [{ address: "10.0.0.5", family: 4 }]);
    const factory = createPublicOnlySocketFactory(PLUGIN);

    const socket = await factory({ host: ["db.example"], port: [5432] });
    const error = await socketError(socket);

    expect(error).toMatchObject({ code: "SSRF_BLOCKED" });
    expect(lookupCalls).toEqual(["db.example"]);
  });

  it("refuses an answer that mixes public and private addresses", async () => {
    fakeDns.set("dual.example", [
      { address: "93.184.216.34", family: 4 },
      { address: "192.168.1.1", family: 4 },
    ]);
    const factory = createPublicOnlySocketFactory(PLUGIN);

    const socket = await factory({ host: ["dual.example"], port: [5432] });

    await expect(socketError(socket)).resolves.toMatchObject({
      code: "SSRF_BLOCKED",
    });
  });

  it("passes a DNS failure through unchanged", async () => {
    const factory = createPublicOnlySocketFactory(PLUGIN);

    const socket = await factory({ host: ["nx.example"], port: [5432] });

    await expect(socketError(socket)).resolves.toMatchObject({
      code: "ENOTFOUND",
    });
    expect(mockSecurityEvent).not.toHaveBeenCalled();
  });

  it("records a security event and the safe-fetch block metric for a refused DNS answer", async () => {
    fakeDns.set("db.example", [{ address: "10.0.0.5", family: 4 }]);
    const factory = createPublicOnlySocketFactory(PLUGIN);

    await socketError(await factory({ host: ["db.example"], port: [5432] }));

    expect(mockSecurityEvent).toHaveBeenCalledWith(
      "ssrf_connection_blocked",
      expect.objectContaining({
        plugin: PLUGIN,
        hostname: "db.example",
        resolved_ip: "10.0.0.5",
        reason: "private-ip",
      })
    );
    expect(incrementCounter).toHaveBeenCalledWith(
      "safe_fetch.blocks.total",
      expect.objectContaining({ plugin_name: PLUGIN, shadow: "false" })
    );
  });

  it("records a security event and the block metric for a refused literal", async () => {
    const factory = createPublicOnlySocketFactory(PLUGIN);

    await factory({ host: ["169.254.169.254"], port: [5432] }).catch(
      () => undefined
    );

    expect(mockSecurityEvent).toHaveBeenCalledWith(
      "ssrf_connection_blocked",
      expect.objectContaining({ plugin: PLUGIN, hostname: "169.254.169.254" })
    );
    expect(incrementCounter).toHaveBeenCalledWith(
      "safe_fetch.blocks.total",
      expect.objectContaining({ plugin_name: PLUGIN })
    );
  });

  it("keeps an error listener on the socket it returns", async () => {
    fakeDns.set("db.example", [{ address: "10.0.0.5", family: 4 }]);
    const factory = createPublicOnlySocketFactory(PLUGIN);

    const socket = await factory({ host: ["db.example"], port: [5432] });

    expect(socket.listenerCount("error")).toBeGreaterThan(0);
    expect(() => socket.emit("error", new Error("peer reset"))).not.toThrow();
    socket.destroy();
  });

  it("keeps the original hostname on the socket for TLS SNI", async () => {
    fakeDns.set("db.example", [{ address: "10.0.0.5", family: 4 }]);
    const factory = createPublicOnlySocketFactory(PLUGIN);

    const socket = await factory({ host: ["db.example"], port: [6543] });

    expect(socket).toMatchObject({ host: "db.example", port: 6543 });
    socket.destroy();
  });

  it("rejects a target with no host", async () => {
    const factory = createPublicOnlySocketFactory(PLUGIN);

    await expect(factory({ host: [], port: [5432] })).rejects.toThrow(
      MISSING_HOST
    );
  });
});

describe("withPublicOnlySocket", () => {
  it("adds a typed socket factory and keeps the other options", () => {
    const options = withPublicOnlySocket(
      { max: 1, connect_timeout: 5 },
      PLUGIN
    );

    expect(options).toMatchObject({ max: 1, connect_timeout: 5 });
    expect(typeof options.socket).toBe("function");
  });
});
