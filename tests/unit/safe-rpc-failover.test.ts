import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const getRpcProviderFromUrls = vi.fn();
const getRpcUrlByChainId = vi.fn();

vi.mock("@/lib/rpc/provider-factory", () => ({
  getRpcProviderFromUrls: (...args: unknown[]) =>
    getRpcProviderFromUrls(...args),
}));

vi.mock("@/lib/rpc/rpc-config", () => ({
  getRpcUrlByChainId: (...args: unknown[]) => getRpcUrlByChainId(...args),
}));

import { buildFailoverRpcManager } from "@/lib/safe/rpc";

/**
 * Regression coverage for the dedup guard in buildFailoverRpcManager.
 * When a chain has no fallback URL configured, getRpcUrlByChainId returns
 * the same URL for both "primary" and "fallback". Constructing a manager
 * with two identical URLs would silently flap between two endpoints that
 * are actually the same machine, defeating the failover. The helper
 * recognises this and passes `undefined` as the fallback in that case.
 */
describe("buildFailoverRpcManager", () => {
  beforeEach(() => {
    getRpcProviderFromUrls.mockReset();
    getRpcUrlByChainId.mockReset();
    getRpcProviderFromUrls.mockResolvedValue({
      tag: "fake-manager",
    });
  });

  it("passes primary and fallback through when they differ", async () => {
    getRpcUrlByChainId.mockImplementation((_chainId: number, type: string) =>
      type === "primary"
        ? "https://primary.example/rpc"
        : "https://fallback.example/rpc"
    );

    await buildFailoverRpcManager(1);

    expect(getRpcProviderFromUrls).toHaveBeenCalledWith(
      "https://primary.example/rpc",
      "https://fallback.example/rpc",
      1
    );
  });

  it("dedupes fallback to undefined when it resolves to the same URL as primary", async () => {
    const same = "https://only-one.example/rpc";
    getRpcUrlByChainId.mockReturnValue(same);

    await buildFailoverRpcManager(42_161);

    expect(getRpcProviderFromUrls).toHaveBeenCalledWith(
      same,
      undefined,
      42_161
    );
  });

  it("returns the primary URL alongside the manager so callers can reuse it", async () => {
    getRpcUrlByChainId.mockImplementation((_chainId: number, type: string) =>
      type === "primary" ? "https://p/rpc" : "https://f/rpc"
    );

    const result = await buildFailoverRpcManager(1);

    expect(result.rpcUrl).toBe("https://p/rpc");
    expect(result.rpcManager).toEqual({ tag: "fake-manager" });
  });
});
