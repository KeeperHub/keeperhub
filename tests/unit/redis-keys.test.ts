import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deploymentKey,
  newDeviceNotifyClaimKey,
  trustedCountryKey,
} from "@/lib/redis-keys";

describe("deploymentKey", () => {
  it("prefixes a single part with the default 'local' namespace", () => {
    expect(deploymentKey("a")).toBe("local:a");
  });

  it("joins multiple parts under the namespace", () => {
    expect(deploymentKey("a", "b", "c")).toBe("local:a:b:c");
  });
});

describe("newDeviceNotifyClaimKey", () => {
  it("builds a device-notify key through deploymentKey", () => {
    expect(newDeviceNotifyClaimKey("u1", "dev-1")).toBe(
      "local:device-notify:u1:dev-1"
    );
  });
});

describe("trustedCountryKey", () => {
  it("builds a country trust key through deploymentKey", () => {
    expect(trustedCountryKey("u1", "US")).toBe("local:trust-country:u1:US");
  });
});

describe("REDIS_KEY_PREFIX per deployment", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("namespaces keys with the configured prefix", async () => {
    // The prefix is read at module load, so reset + re-import after stubbing.
    vi.stubEnv("REDIS_KEY_PREFIX", "staging");
    vi.resetModules();
    const mod = await import("@/lib/redis-keys");

    expect(mod.deploymentKey("device-notify", "u1", "dev-1")).toBe(
      "staging:device-notify:u1:dev-1"
    );
    expect(mod.newDeviceNotifyClaimKey("u1", "dev-1")).toBe(
      "staging:device-notify:u1:dev-1"
    );
  });

  it("isolates two deployments sharing one Redis instance", async () => {
    vi.stubEnv("REDIS_KEY_PREFIX", "pr-42");
    vi.resetModules();
    const mod = await import("@/lib/redis-keys");

    // Same user + device on a different deployment lands on a different key.
    expect(mod.newDeviceNotifyClaimKey("u1", "dev-1")).not.toBe(
      "staging:device-notify:u1:dev-1"
    );
    expect(mod.newDeviceNotifyClaimKey("u1", "dev-1")).toBe(
      "pr-42:device-notify:u1:dev-1"
    );
  });
});
