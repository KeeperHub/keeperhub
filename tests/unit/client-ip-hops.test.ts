import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `resolveIpFromHeaderValue` is what stops a caller choosing its own address
 * once a deployment names a header the caller can also send. Confirmed against
 * a deployed install on 2026-08-25: before this rule existed the resolver
 * returned the whole `client, proxy` string and it became the rate-limit key.
 */
describe("resolveIpFromHeaderValue", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  async function loadWith(
    proxies: string | undefined
  ): Promise<typeof import("@/lib/security/client-ip")> {
    const { CLIENT_IP_TRUSTED_PROXIES: _omitted, ...rest } = originalEnv;
    process.env =
      proxies === undefined
        ? (rest as NodeJS.ProcessEnv)
        : { ...rest, CLIENT_IP_TRUSTED_PROXIES: proxies };
    return await import("@/lib/security/client-ip");
  }

  describe("with no trusted proxy named", () => {
    it("accepts a single address", async () => {
      const { resolveIpFromHeaderValue } = await loadWith(undefined);
      expect(resolveIpFromHeaderValue("203.0.113.7")).toBe("203.0.113.7");
    });

    it("trims surrounding whitespace", async () => {
      const { resolveIpFromHeaderValue } = await loadWith(undefined);
      expect(resolveIpFromHeaderValue("  203.0.113.7  ")).toBe("203.0.113.7");
    });

    // The whole point of the rule. The leftmost hop is whatever the caller
    // sent, so accepting it would let the caller pick its own address.
    it("refuses a chain of hops", async () => {
      const { resolveIpFromHeaderValue } = await loadWith(undefined);
      expect(resolveIpFromHeaderValue("1.2.3.4, 203.0.113.7")).toBeNull();
    });

    it("refuses a value that is not an address", async () => {
      const { resolveIpFromHeaderValue } = await loadWith(undefined);
      expect(resolveIpFromHeaderValue("not-an-ip")).toBeNull();
    });

    it("refuses an empty value", async () => {
      const { resolveIpFromHeaderValue } = await loadWith(undefined);
      expect(resolveIpFromHeaderValue("")).toBeNull();
      expect(resolveIpFromHeaderValue(" , ")).toBeNull();
    });

    it("accepts IPv6, including the IPv4-mapped form", async () => {
      const { resolveIpFromHeaderValue } = await loadWith(undefined);
      expect(resolveIpFromHeaderValue("2001:db8::1")).toBe("2001:db8::1");
      expect(resolveIpFromHeaderValue("::ffff:203.0.113.7")).toBe(
        "::ffff:203.0.113.7"
      );
    });

    it("refuses an octet above 255", async () => {
      const { resolveIpFromHeaderValue } = await loadWith(undefined);
      expect(resolveIpFromHeaderValue("203.0.113.999")).toBeNull();
    });
  });

  describe("with trusted proxies named", () => {
    it("reads the chain from the right and skips our own proxies", async () => {
      const { resolveIpFromHeaderValue } = await loadWith("203.0.113.0/24");
      expect(resolveIpFromHeaderValue("1.2.3.4, 203.0.113.7")).toBe("1.2.3.4");
    });

    it("skips several trusted hops in a row", async () => {
      const { resolveIpFromHeaderValue } = await loadWith(
        "203.0.113.0/24,198.51.100.5"
      );
      expect(
        resolveIpFromHeaderValue("1.2.3.4, 198.51.100.5, 203.0.113.7")
      ).toBe("1.2.3.4");
    });

    it("returns null when every hop is one of our proxies", async () => {
      const { resolveIpFromHeaderValue } = await loadWith("203.0.113.0/24");
      expect(resolveIpFromHeaderValue("203.0.113.1, 203.0.113.7")).toBeNull();
    });

    // Fail closed: a malformed hop means the chain cannot be trusted, and
    // returning the hop to its left would hand back one of our own proxies.
    it("returns null when a hop is malformed", async () => {
      const { resolveIpFromHeaderValue } = await loadWith("203.0.113.0/24");
      expect(resolveIpFromHeaderValue("1.2.3.4, junk, 203.0.113.7")).toBeNull();
    });

    it("still accepts a single untrusted address", async () => {
      const { resolveIpFromHeaderValue } = await loadWith("203.0.113.0/24");
      expect(resolveIpFromHeaderValue("1.2.3.4")).toBe("1.2.3.4");
    });

    it("ignores a malformed proxy entry rather than widening the set", async () => {
      const { resolveIpFromHeaderValue } = await loadWith("not-a-cidr");
      // No valid proxy remains, so the single-hop rule applies again.
      expect(resolveIpFromHeaderValue("1.2.3.4, 203.0.113.7")).toBeNull();
    });

    it("matches an exact address with no prefix", async () => {
      const { resolveIpFromHeaderValue } = await loadWith("203.0.113.7");
      expect(resolveIpFromHeaderValue("1.2.3.4, 203.0.113.7")).toBe("1.2.3.4");
    });
  });
});
