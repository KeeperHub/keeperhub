import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  detectProxyViaRpc: vi.fn(),
  fetchEtherscanAbi: vi.fn(),
  fetchEtherscanSourceCode: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () =>
            Promise.resolve([{ explorerApiUrl: "https://explorer.example" }]),
        }),
      }),
    }),
  },
}));
vi.mock("@/lib/explorer/etherscan", () => ({
  fetchEtherscanAbi: mocks.fetchEtherscanAbi,
  fetchEtherscanSourceCode: mocks.fetchEtherscanSourceCode,
}));
vi.mock("@/lib/explorer/proxy-detection", () => ({
  detectProxyViaRpc: mocks.detectProxyViaRpc,
}));

import { resolveAbi } from "@/lib/abi/cache";
import { PlatformRpcPurpose, RpcScopeKind } from "@/lib/rpc/engine/types";

const PROXY = "0x1111111111111111111111111111111111111111";
const IMPLEMENTATION = "0x2222222222222222222222222222222222222222";
const IMPLEMENTATION_ABI = [{ type: "function", name: "transfer" }];

describe("resolveAbi", () => {
  it("probes proxies on KeeperHub's endpoints, since the result is shared", async () => {
    mocks.fetchEtherscanAbi.mockImplementation(
      (_url: string, _chain: number, address: string) =>
        Promise.resolve(
          address === IMPLEMENTATION
            ? { success: true, abi: IMPLEMENTATION_ABI }
            : { success: true, abi: [] }
        )
    );
    mocks.fetchEtherscanSourceCode.mockResolvedValue({
      success: true,
      isProxy: false,
    });
    mocks.detectProxyViaRpc.mockResolvedValue({
      isProxy: true,
      implementationAddress: IMPLEMENTATION,
    });

    const resolved = await resolveAbi({ contractAddress: PROXY, network: "1" });

    expect(JSON.parse(resolved.abi)).toEqual(IMPLEMENTATION_ABI);
    expect(mocks.detectProxyViaRpc).toHaveBeenCalledWith(PROXY, 1, {
      kind: RpcScopeKind.PLATFORM,
      purpose: PlatformRpcPurpose.SHARED_CACHE,
    });
  });
});
