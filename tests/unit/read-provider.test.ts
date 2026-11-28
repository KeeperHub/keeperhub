import { beforeEach, describe, expect, it, vi } from "vitest";

const { getRpcProvider } = vi.hoisted(() => ({
  getRpcProvider: vi.fn(),
}));
vi.mock("@/lib/rpc/provider-factory", () => ({ getRpcProvider }));

import type { RpcProviderManager } from "@/lib/rpc/providers";
import { readRpcFor } from "@/lib/rpc/read-provider";

function manager(relay: boolean): RpcProviderManager {
  return {
    hasPrivateRelayPrimary: () => relay,
  } as unknown as RpcProviderManager;
}

beforeEach(() => {
  getRpcProvider.mockReset();
});

describe("readRpcFor", () => {
  it("reads through the send's own manager on a normal send", async () => {
    const send = manager(false);
    expect(await readRpcFor(send, { chainId: 1, userId: "u1" })).toBe(send);
    expect(getRpcProvider).not.toHaveBeenCalled();
  });

  it("reads through the chain's regular RPC when the send uses the relay", async () => {
    const publicRpc = manager(false);
    getRpcProvider.mockResolvedValue(publicRpc);

    expect(await readRpcFor(manager(true), { chainId: 1, userId: "u1" })).toBe(
      publicRpc
    );
    // No relay swap asked for: the user's RPC or the chain default.
    expect(getRpcProvider).toHaveBeenCalledWith({ chainId: 1, userId: "u1" });
  });
});
