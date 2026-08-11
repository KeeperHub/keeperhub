import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// lib/auth pulls in lib/redis (via login-risk) which imports ioredis. Stub it
// so the module graph resolves without a live Redis: this test only inspects
// the statically-constructed plugin list, not any runtime Redis behaviour.
vi.mock("ioredis", () => ({ Redis: class {} }));

// Better Auth plugins expose a stable string `id`. The registered list lives
// on the constructed auth object at `auth.options.plugins`.
type PluginShape = { id: string };

function registeredPluginIds(plugins: unknown[]): string[] {
  return plugins.map((p) => (p as PluginShape).id);
}

describe("auth plugin registration", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not register the better-auth bearer plugin", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const { auth } = await import("@/lib/auth");
    const ids = registeredPluginIds(auth.options.plugins ?? []);
    expect(ids.some((id) => id === "bearer")).toBe(false);
  });

  it("still registers deviceAuthorization and twoFactor (surgical-removal guard)", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const { auth } = await import("@/lib/auth");
    const ids = registeredPluginIds(auth.options.plugins ?? []);
    expect(ids.some((id) => id === "device-authorization")).toBe(true);
    expect(ids.some((id) => id === "two-factor")).toBe(true);
  });
});
