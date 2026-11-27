import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  ownEndpointsScope: vi.fn(),
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
vi.mock("@/lib/rpc/engine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rpc/engine")>()),
  ownEndpointsScope: mocks.ownEndpointsScope,
}));
vi.mock("@/lib/explorer/proxy-detection", () => ({
  detectProxyViaRpc: mocks.detectProxyViaRpc,
}));

import { resolveAbi } from "@/lib/abi/cache";
import { orgScope } from "@/lib/rpc/engine/scope";
import { PlatformRpcPurpose, RpcScopeKind } from "@/lib/rpc/engine/types";

const PROXY = "0x1111111111111111111111111111111111111111";
const IMPLEMENTATION = "0x2222222222222222222222222222222222222222";
const IMPLEMENTATION_ABI = [{ type: "function", name: "transfer" }];

function explorerFindsAProxy(): void {
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
}

describe("resolveAbi", () => {
  it("probes on an own-RPC-only organization's endpoints and keeps the result to it", async () => {
    explorerFindsAProxy();
    const scope = orgScope("org_1");
    mocks.ownEndpointsScope.mockResolvedValue(scope);

    await resolveAbi({
      contractAddress: PROXY,
      network: "10",
      rpcScope: scope,
    });
    expect(mocks.detectProxyViaRpc).toHaveBeenLastCalledWith(PROXY, 10, scope);

    mocks.ownEndpointsScope.mockResolvedValue(null);
    const shared = await resolveAbi({ contractAddress: PROXY, network: "10" });
    expect(shared.source).toBe("explorer");
  });

  it("probes proxies on KeeperHub's endpoints, since the result is shared", async () => {
    mocks.ownEndpointsScope.mockResolvedValue(null);
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
