import { afterEach, describe, expect, it, vi } from "vitest";

async function loadConfig(
  env: Record<string, string | undefined>
): Promise<typeof import("./config").CONFIG> {
  vi.resetModules();
  for (const [name, value] of Object.entries(env)) {
    vi.stubEnv(name, value);
  }
  const { CONFIG } = await import("./config");
  return CONFIG;
}

describe("warm pool config", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is off by default", async () => {
    const config = await loadConfig({ WARM_POOL_SIZE: undefined });
    expect(config.warmPoolSize).toBe(0);
    expect(config.warmPoolIdleTtlSeconds).toBe(600);
    expect(config.warmPoolLongPollSeconds).toBe(20);
    expect(config.warmPoolOrgClaimsPerMinute).toBeUndefined();
    expect(config.warmPoolPreloadActionPrefixes).toBe("web3/");
  });

  it.each([
    ["4", 4],
    ["100", 32],
    ["-1", 0],
    ["abc", 0],
    ["", 0],
  ])("WARM_POOL_SIZE=%s -> %s", async (value, expected) => {
    const config = await loadConfig({ WARM_POOL_SIZE: value });
    expect(config.warmPoolSize).toBe(expected);
  });

  it("never lets durations be zero or invalid, and caps the long poll", async () => {
    const config = await loadConfig({
      WARM_POOL_IDLE_TTL_SECONDS: "0",
      WARM_POOL_LONG_POLL_SECONDS: "120",
    });
    expect(config.warmPoolIdleTtlSeconds).toBe(600);
    expect(config.warmPoolLongPollSeconds).toBe(45);

    const invalid = await loadConfig({ WARM_POOL_LONG_POLL_SECONDS: "-5" });
    expect(invalid.warmPoolLongPollSeconds).toBe(20);
  });

  it.each([
    ["10", 10],
    ["0", undefined],
    ["abc", undefined],
    ["", undefined],
  ])(
    "WARM_POOL_ORG_CLAIMS_PER_MINUTE=%s -> %s (undefined derives it from the pool size)",
    async (value, expected) => {
      const config = await loadConfig({
        WARM_POOL_ORG_CLAIMS_PER_MINUTE: value,
      });
      expect(config.warmPoolOrgClaimsPerMinute).toBe(expected);
    }
  );
});
