import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { mockLookup } = vi.hoisted(() => ({ mockLookup: vi.fn() }));

vi.mock("node:dns", () => ({
  promises: { lookup: mockLookup },
}));

import {
  assertConnectionUrlIsPublic,
  assertHostIsPublic,
  extractHostFromConnectionString,
} from "@/lib/db/connection-host-guard";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("assertHostIsPublic", () => {
  it("rejects empty host", async () => {
    await expect(assertHostIsPublic("")).rejects.toThrow("Host is required");
  });

  it.each([
    ["IPv4 loopback", "127.0.0.1"],
    ["IPv4 private 10/8", "10.0.0.1"],
    ["IPv4 private 192.168/16", "192.168.1.1"],
    ["IPv4 link-local 169.254/16", "169.254.169.254"],
    ["IPv4 CGNAT", "100.64.0.1"],
    ["IPv4 unspecified", "0.0.0.0"],
    ["IPv6 loopback", "::1"],
    ["IPv6 unique-local fc00::/7", "fc00::1"],
    ["IPv6 link-local fe80::/10", "fe80::1"],
    ["IPv4-mapped IPv6 to private", "::ffff:127.0.0.1"],
  ])("rejects literal %s", async (_label, ip) => {
    await expect(assertHostIsPublic(ip)).rejects.toThrow(
      "Host is not allowed: must resolve to a public address"
    );
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it.each([
    ["public Cloudflare", "1.1.1.1"],
    ["public Google", "8.8.8.8"],
    ["public IPv6", "2606:4700:4700::1111"],
  ])("permits public literal %s", async (_label, ip) => {
    await expect(assertHostIsPublic(ip)).resolves.toBeUndefined();
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("permits hostname that resolves only to public addresses", async () => {
    mockLookup.mockResolvedValue([
      { address: "8.8.8.8", family: 4 },
      { address: "2001:4860:4860::8888", family: 6 },
    ]);

    await expect(assertHostIsPublic("dns.google")).resolves.toBeUndefined();
    expect(mockLookup).toHaveBeenCalledWith("dns.google", { all: true });
  });

  it("rejects hostname that resolves to a private address", async () => {
    mockLookup.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);

    // Uses .example TLD so the hostname does not match the pre-DNS
    // isBlockedHost denylist; we want to exercise the DNS-resolution path
    // specifically.
    await expect(assertHostIsPublic("internal-db.example")).rejects.toThrow(
      "Host is not allowed: must resolve to a public address"
    );
    expect(mockLookup).toHaveBeenCalled();
  });

  it("rejects hostname that resolves to a mix of public and private addresses", async () => {
    mockLookup.mockResolvedValue([
      { address: "8.8.8.8", family: 4 },
      { address: "192.168.1.1", family: 4 },
    ]);

    await expect(assertHostIsPublic("dual-homed.example")).rejects.toThrow(
      "Host is not allowed: must resolve to a public address"
    );
  });

  it("rejects hostname that fails DNS resolution", async () => {
    mockLookup.mockRejectedValue(new Error("ENOTFOUND"));

    await expect(assertHostIsPublic("nx.invalid")).rejects.toThrow(
      "Host could not be resolved"
    );
  });

  it("rejects localhost before any DNS lookup", async () => {
    // isBlockedHost catches `localhost` as a pre-DNS pattern, so the
    // resolver is never consulted. The mock is only here to prove the
    // negative.
    mockLookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);

    await expect(assertHostIsPublic("localhost")).rejects.toThrow(
      "Host is not allowed: must resolve to a public address"
    );
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it.each([
    ["case-insensitive localhost", "LOCALHOST"],
    ["trailing-dot FQDN form", "localhost."],
    ["mDNS .local suffix", "raspberrypi.local"],
    [".internal suffix", "service.internal"],
    ["EC2 VPC internal hostname", "ip-10-0-0-5.us-east-2.compute.internal"],
    ["k8s service DNS", "keeperhub-common.keeperhub.svc.cluster.local"],
    ["k8s pod DNS", "mypod.keeperhub.pod.cluster.local"],
  ])("rejects %s before any DNS lookup", async (_label, host) => {
    await expect(assertHostIsPublic(host)).rejects.toThrow(
      "Host is not allowed: must resolve to a public address"
    );
    expect(mockLookup).not.toHaveBeenCalled();
  });
});

describe("extractHostFromConnectionString", () => {
  it.each([
    [
      "postgres scheme with IPv4 host",
      "postgres://u:p@10.0.0.1:5432/db",
      "10.0.0.1",
    ],
    [
      "postgresql scheme with hostname",
      "postgresql://user:pass@db.example.com:5432/mydb",
      "db.example.com",
    ],
    [
      "URL-encoded password with @",
      "postgres://user:p%40ss@db.example.com:5432/db",
      "db.example.com",
    ],
    ["no port", "postgres://u:p@host.example/db", "host.example"],
    ["no credentials", "postgres://host.example:5432/db", "host.example"],
    [
      "IPv6 host (square-bracketed per URL spec)",
      "postgres://u:p@[::1]:5432/db",
      "[::1]",
    ],
  ])("extracts %s", (_label, url, expected) => {
    expect(extractHostFromConnectionString(url)).toBe(expected);
  });

  it.each([
    ["empty string", ""],
    ["plain garbage", "not-a-url"],
    ["scheme-only", "postgres://"],
  ])("returns null for %s", (_label, url) => {
    expect(extractHostFromConnectionString(url)).toBeNull();
  });

  it("end-to-end: a connection string pointing at 10.0.0.1 is rejected by the guard", async () => {
    const url = "postgres://u:p@10.0.0.1:5432/db";
    const host = extractHostFromConnectionString(url);
    expect(host).toBe("10.0.0.1");
    if (!host) {
      throw new Error("Unreachable: extraction returned null");
    }
    await expect(assertHostIsPublic(host)).rejects.toThrow(
      "Host is not allowed: must resolve to a public address"
    );
    expect(mockLookup).not.toHaveBeenCalled();
  });
});

describe("assertConnectionUrlIsPublic", () => {
  it.each([
    ["IPv4 loopback", "postgres://u:p@127.0.0.1:5432/db"],
    ["IPv4 private 10/8", "postgres://u:p@10.0.0.1:5432/db"],
    ["IPv4 private 192.168/16", "postgres://u:p@192.168.1.1:5432/db"],
    ["IPv4 IMDS link-local", "postgres://u:p@169.254.169.254:5432/db"],
    ["IPv6 loopback (bracketed)", "postgres://u:p@[::1]:5432/db"],
    ["IPv6 ULA (bracketed)", "postgres://u:p@[fc00::1]:5432/db"],
    ["IPv6 site-local NAT64", "postgres://u:p@[64:ff9b:1::1]:5432/db"],
    ["IPv6 Teredo", "postgres://u:p@[2001::1]:5432/db"],
    [
      "IPv4-mapped IPv6 to private",
      "postgres://u:p@[::ffff:127.0.0.1]:5432/db",
    ],
  ])("rejects %s before any DNS lookup", async (_label, url) => {
    await expect(assertConnectionUrlIsPublic(url)).rejects.toThrow(
      "Host is not allowed: must resolve to a public address"
    );
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it.each([
    ["localhost", "postgres://u:p@localhost:5432/db"],
    [
      "k8s service DNS",
      "postgres://u:p@db.keeperhub.svc.cluster.local:5432/db",
    ],
    [
      "EC2 VPC internal hostname",
      "postgres://u:p@ip-10-0-0-5.us-east-2.compute.internal:5432/db",
    ],
    ["mDNS suffix", "postgres://u:p@raspberrypi.local:5432/db"],
  ])("rejects hostname pattern %s before any DNS lookup", async (_label, url) => {
    await expect(assertConnectionUrlIsPublic(url)).rejects.toThrow(
      "Host is not allowed: must resolve to a public address"
    );
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("rejects hostname that resolves to a private address", async () => {
    mockLookup.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
    await expect(
      assertConnectionUrlIsPublic("postgres://u:p@db.example/x")
    ).rejects.toThrow("Host is not allowed: must resolve to a public address");
    expect(mockLookup).toHaveBeenCalled();
  });

  it("permits hostname that resolves only to public addresses", async () => {
    mockLookup.mockResolvedValue([{ address: "1.1.1.1", family: 4 }]);
    await expect(
      assertConnectionUrlIsPublic("postgres://u:p@db.example.com:5432/db")
    ).resolves.toBeUndefined();
  });

  it.each([
    ["IPv4 literal", "postgres://u:p@1.1.1.1:5432/db"],
    [
      "IPv6 literal (bracketed)",
      "postgres://u:p@[2606:4700:4700::1111]:5432/db",
    ],
  ])("permits public %s without any DNS lookup", async (_label, url) => {
    await expect(assertConnectionUrlIsPublic(url)).resolves.toBeUndefined();
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it.each([
    ["empty string", ""],
    ["plain garbage", "not-a-url"],
    ["scheme-only", "postgres://"],
  ])("throws for malformed URL: %s", async (_label, url) => {
    await expect(assertConnectionUrlIsPublic(url)).rejects.toThrow(
      "Connection string is missing a host"
    );
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("error messages never echo the connection string", async () => {
    let thrown: unknown;
    try {
      await assertConnectionUrlIsPublic(
        "postgres://supersecretuser:supersecretpassword@10.0.0.1:5432/internal"
      );
    } catch (err) {
      thrown = err;
    }
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).not.toContain("supersecret");
    expect(message).not.toContain("10.0.0.1");
    expect(message).not.toContain("internal");
  });
});
