/**
 * The L2 slug alias, driven through the step that actually runs it.
 *
 * tests/unit/resolve-protocol-meta.test.ts pins what the resolver returns,
 * and the coverage suites exercise the new `-l2` slugs - but nothing called
 * an old slug on an L2 through protocolReadStep, which is the path a workflow
 * saved before the split takes on its next run. Everything below the resolver
 * is real: the registry, the alias, the contract lookup and the argument
 * builder. Only the two outward edges are stubbed (ABI resolution and the RPC
 * read), so what is asserted is the address and calldata the step would have
 * put on the wire.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/workflow/executor/step-handler", () => ({
  withStepLogging: (_input: unknown, fn: () => unknown) => fn(),
}));

const mockResolveAbi = vi.fn();
vi.mock("@/lib/abi/cache", () => ({
  resolveAbi: (...args: unknown[]) => mockResolveAbi(...args),
}));

const mockReadContractCore = vi.fn();
vi.mock("@/plugins/web3/steps/read-contract-core", () => ({
  readContractCore: (...args: unknown[]) => mockReadContractCore(...args),
}));

import { protocolReadStep } from "@/plugins/protocol/steps/protocol-read";

const WALLET = "0x1111111111111111111111111111111111111111";

// The addresses are spelled out rather than read back off the registry: a
// lookup would pass against a registry that lost the deployment, which is the
// regression this file exists to catch.
const SUSDS_BASE = "0x5875eEE11Cf8398102FdAd704C9E96607675467a";
const SUSDS_ARBITRUM = "0xdDb46999F8891663a8F2828d25298f70416d7610";
const WSTETH_BASE = "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452";

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveAbi.mockImplementation(({ abi }: { abi?: string }) => ({
    abi: abi ?? "[]",
  }));
  mockReadContractCore.mockResolvedValue({ success: true, data: "0" });
});

describe("protocolReadStep: an old slug on an L2", () => {
  const cases = [
    {
      actionType: "sky/vault-balance",
      network: "8453",
      address: SUSDS_BASE,
      abiFunction: "balanceOf",
      args: JSON.stringify([WALLET]),
    },
    {
      actionType: "sky/vault-balance",
      network: "42161",
      address: SUSDS_ARBITRUM,
      abiFunction: "balanceOf",
      args: JSON.stringify([WALLET]),
    },
    {
      actionType: "sky/vault-total-supply",
      network: "8453",
      address: SUSDS_BASE,
      abiFunction: "totalSupply",
      args: undefined,
    },
    {
      actionType: "lido/get-wsteth-balance",
      network: "8453",
      address: WSTETH_BASE,
      abiFunction: "balanceOf",
      args: JSON.stringify([WALLET]),
    },
  ] as const;

  for (const c of cases) {
    it(`${c.actionType} on ${c.network} reads the L2 contract`, async () => {
      const result = await protocolReadStep({
        network: c.network,
        _actionType: c.actionType,
        account: WALLET,
      });

      expect(result.success).toBe(true);
      expect(mockReadContractCore).toHaveBeenCalledTimes(1);
      expect(mockReadContractCore.mock.calls[0]?.[0]).toMatchObject({
        contractAddress: c.address,
        network: c.network,
        abiFunction: c.abiFunction,
        functionArgs: c.args,
      });
    });
  }

  it("still reads the mainnet contract on a chain the alias does not cover", async () => {
    await protocolReadStep({
      network: "1",
      _actionType: "sky/vault-balance",
      account: WALLET,
    });

    expect(mockReadContractCore.mock.calls[0]?.[0]).toMatchObject({
      contractAddress: "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD",
      abiFunction: "balanceOf",
    });
  });

  it("prefers the action type over a stale _protocolMeta snapshot", async () => {
    // What a caller that persisted the pre-split meta sends. The alias lives
    // on the _actionType branch only, so if the snapshot won here the read
    // would fail with `contract "sUsds" is not deployed on network "8453"`.
    const result = await protocolReadStep({
      network: "8453",
      _actionType: "sky/vault-balance",
      _protocolMeta: JSON.stringify({
        protocolSlug: "sky",
        contractKey: "sUsds",
        functionName: "balanceOf",
        actionType: "read",
      }),
      account: WALLET,
    });

    expect(result.success).toBe(true);
    expect(mockReadContractCore.mock.calls[0]?.[0]).toMatchObject({
      contractAddress: SUSDS_BASE,
    });
  });
});
