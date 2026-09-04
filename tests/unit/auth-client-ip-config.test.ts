import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// lib/auth pulls in lib/redis (via login-risk) which imports ioredis. Stub it so
// the module graph resolves without a live Redis: this test only inspects the
// statically-constructed options object.
vi.mock("ioredis", () => ({ Redis: class {} }));

/**
 * better-auth resolves the client IP for its rate-limit keys and for
 * sessions.ip_address from `advanced.ipAddress`. These cases pin what
 * lib/auth.ts hands it, so a change to the seam cannot silently widen or empty
 * that list.
 */
type IpAddressOptions = {
  ipAddressHeaders?: string[];
  trustedProxies?: string[];
};

describe("better-auth client IP configuration", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  async function loadWith(
    vars: Record<string, string | undefined>
  ): Promise<IpAddressOptions> {
    // Rebuilt without the keys so an unset case really is absent; assigning
    // undefined would store the literal string "undefined".
    const {
      CLIENT_IP_HEADERS: _headers,
      CLIENT_IP_TRUSTED_PROXIES: _proxies,
      ...rest
    } = originalEnv;
    const next: NodeJS.ProcessEnv = { ...rest, NODE_ENV: "test" };
    for (const [key, value] of Object.entries(vars)) {
      if (value !== undefined) {
        next[key] = value;
      }
    }
    process.env = next;
    const { auth } = await import("@/lib/auth");
    return (auth.options.advanced?.ipAddress ?? {}) as IpAddressOptions;
  }

  // The whole backward-compatibility claim. KeeperHub's own deployments set
  // nothing, so better-auth must see exactly what it saw before the seam existed.
  it("unset passes only CF-Connecting-IP and no trustedProxies", async () => {
    const ipAddress = await loadWith({});
    expect(ipAddress.ipAddressHeaders).toEqual(["cf-connecting-ip"]);
    expect(ipAddress).not.toHaveProperty("trustedProxies");
  });

  it("passes a configured header list through", async () => {
    const ipAddress = await loadWith({ CLIENT_IP_HEADERS: "X-Real-IP" });
    expect(ipAddress.ipAddressHeaders).toEqual(["x-real-ip"]);
  });

  // An empty ipAddressHeaders would make better-auth fall back to its own
  // x-forwarded-for default, whose leftmost hop the caller controls.
  it("never hands better-auth an empty header list", async () => {
    const ipAddress = await loadWith({ CLIENT_IP_HEADERS: "  ,  " });
    expect(ipAddress.ipAddressHeaders).toEqual(["cf-connecting-ip"]);
  });

  // Absent rather than empty: better-auth only enforces its single-hop rule
  // while trustedProxies is unset.
  it("omits trustedProxies entirely when the variable is empty", async () => {
    const ipAddress = await loadWith({
      CLIENT_IP_HEADERS: "X-Forwarded-For",
      CLIENT_IP_TRUSTED_PROXIES: "",
    });
    expect(ipAddress).not.toHaveProperty("trustedProxies");
  });

  it("passes configured proxies through when set", async () => {
    const ipAddress = await loadWith({
      CLIENT_IP_HEADERS: "X-Forwarded-For",
      CLIENT_IP_TRUSTED_PROXIES: "10.42.0.0/16, 192.168.1.5",
    });
    expect(ipAddress.trustedProxies).toEqual(["10.42.0.0/16", "192.168.1.5"]);
  });
});
