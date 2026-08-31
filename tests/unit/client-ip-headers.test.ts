import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Both lists are built once at module load, so every case re-imports the module
 * after changing the environment rather than merely re-reading it.
 */
describe("CLIENT_IP_HEADERS", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  async function loadWith(
    value: string | undefined
  ): Promise<typeof import("@/lib/security/client-ip")> {
    // The env is rebuilt without the key rather than having it removed, so the
    // unset case really is absent. Assigning undefined would not do: that stores
    // the literal string "undefined", which the parser would then treat as a
    // configured value.
    const { CLIENT_IP_HEADERS: _omitted, ...rest } = originalEnv;
    process.env =
      value === undefined
        ? (rest as NodeJS.ProcessEnv)
        : { ...rest, CLIENT_IP_HEADERS: value };
    return await import("@/lib/security/client-ip");
  }

  // The whole backward-compatibility claim. Production sets nothing, so the list
  // must be what the two call sites hardcoded before this variable existed.
  it("unset reproduces the built-in list exactly", async () => {
    const { CLIENT_IP_HEADERS } = await loadWith(undefined);
    expect([...CLIENT_IP_HEADERS]).toEqual(["cf-connecting-ip"]);
  });

  it("honours a single name, trimmed and lowercased", async () => {
    const { CLIENT_IP_HEADERS } = await loadWith("  X-Real-IP  ");
    expect([...CLIENT_IP_HEADERS]).toEqual(["x-real-ip"]);
  });

  it("keeps the order of several names", async () => {
    const { CLIENT_IP_HEADERS } = await loadWith(
      "X-Real-IP, CF-Connecting-IP, X-Forwarded-For"
    );
    expect([...CLIENT_IP_HEADERS]).toEqual([
      "x-real-ip",
      "cf-connecting-ip",
      "x-forwarded-for",
    ]);
  });

  it("drops empty entries left by a trailing or doubled comma", async () => {
    const { CLIENT_IP_HEADERS } = await loadWith("X-Real-IP,,");
    expect([...CLIENT_IP_HEADERS]).toEqual(["x-real-ip"]);
  });

  // A header name is an RFC 7230 token. Anything else is a malformed config line
  // rather than a header a caller could send, so it must not reach Headers.get.
  it.each([
    ["a name with a space", "X Real IP"],
    ["a name with a colon", "X-Real-IP:"],
    ["a quoted name", '"X-Real-IP"'],
    ["a name with a slash", "X-Real-IP/1"],
  ])("drops %s", async (_label, value) => {
    const { CLIENT_IP_HEADERS } = await loadWith(value);
    expect([...CLIENT_IP_HEADERS]).toEqual(["cf-connecting-ip"]);
  });

  it("keeps the valid names when only some entries are malformed", async () => {
    const { CLIENT_IP_HEADERS } = await loadWith("X Real IP, X-Real-IP");
    expect([...CLIENT_IP_HEADERS]).toEqual(["x-real-ip"]);
  });

  // An empty list is not the same as the default: better-auth reads an empty
  // ipAddressHeaders as "unset" and falls back to its own x-forwarded-for, which
  // is the opposite of what an operator who set the variable asked for.
  it("falls back to the default rather than an empty list", async () => {
    const { CLIENT_IP_HEADERS } = await loadWith("   ,  ,");
    expect([...CLIENT_IP_HEADERS]).toEqual(["cf-connecting-ip"]);
  });
});

describe("CLIENT_IP_TRUSTED_PROXIES", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  async function loadWith(
    value: string | undefined
  ): Promise<typeof import("@/lib/security/client-ip")> {
    const { CLIENT_IP_TRUSTED_PROXIES: _omitted, ...rest } = originalEnv;
    process.env =
      value === undefined
        ? (rest as NodeJS.ProcessEnv)
        : { ...rest, CLIENT_IP_TRUSTED_PROXIES: value };
    return await import("@/lib/security/client-ip");
  }

  // Unset must stay empty, because lib/auth.ts passes the option to better-auth
  // only when it is non-empty and an empty list would relax the single-hop rule.
  it("unset yields an empty list", async () => {
    const { CLIENT_IP_TRUSTED_PROXIES } = await loadWith(undefined);
    expect([...CLIENT_IP_TRUSTED_PROXIES]).toEqual([]);
  });

  it("keeps addresses and CIDR ranges verbatim, trimmed", async () => {
    const { CLIENT_IP_TRUSTED_PROXIES } = await loadWith(
      " 10.42.0.0/16 , 192.168.1.5 "
    );
    expect([...CLIENT_IP_TRUSTED_PROXIES]).toEqual([
      "10.42.0.0/16",
      "192.168.1.5",
    ]);
  });

  it("drops empty entries", async () => {
    const { CLIENT_IP_TRUSTED_PROXIES } = await loadWith("10.42.0.0/16,,");
    expect([...CLIENT_IP_TRUSTED_PROXIES]).toEqual(["10.42.0.0/16"]);
  });
});
