import { ethers } from "ethers";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/db/schema", () => ({ explorerConfigs: {} }));
vi.mock("drizzle-orm", () => ({ eq: () => ({}) }));
vi.mock("@/lib/explorer", () => ({
  getAddressUrl: () => "",
  getTransactionUrl: () => "",
}));
vi.mock("@/keeperhub-executor/lib/broadcast-marker", () => ({
  markBroadcast: vi.fn(),
}));

const mockSubmit = vi.fn();
vi.mock("@/lib/web3/submit-signed", () => ({
  submitSignedTransactionWithFailover: (...args: unknown[]) =>
    mockSubmit(...args),
}));

const mockSimulate = vi.fn();
vi.mock("@/lib/web3/next-block-simulation", () => ({
  simulateSendAtNextBlock: (...args: unknown[]) => mockSimulate(...args),
}));

import type { RpcProviderManager } from "@/lib/rpc/providers";
import { EvmChainAdapter } from "@/lib/web3/chain-adapter/evm";

const CHAIN_ID = 1;
const SIGNER = "0x2c9F694183A4240B6431771F6c714a8106179dF5";
const TARGET = "0x779877A7B0D9E8603169DdbD7836e478b4624789";
const ABI = ["function run(uint256 id)"];
const SIMULATION = {
  mode: "next-block",
  baseBlock: 100,
  assumedBlockNumber: 101,
  assumedTimestamp: 1_000_012,
  rpcMethod: "eth_estimateGas+blockOverrides",
};
const RECEIPT = {
  hash: "0xtxhash",
  gasUsed: BigInt(46_000),
  effectiveGasPrice: BigInt(1_000_000_000),
  blockNumber: 101,
};

function setup(): {
  adapter: EvmChainAdapter;
  getGasConfig: ReturnType<typeof vi.fn>;
  signer: ethers.Signer;
  rpcManager: RpcProviderManager;
  executeWithFailover: ReturnType<typeof vi.fn>;
} {
  const getGasConfig = vi.fn().mockResolvedValue({
    gasLimit: BigInt(70_000),
    maxFeePerGas: BigInt(2_000_000_000),
    maxPriorityFeePerGas: BigInt(1_000_000),
  });
  const adapter = new EvmChainAdapter(
    CHAIN_ID,
    { getGasConfig } as never,
    { getNextNonce: vi.fn().mockReturnValue(7) } as never
  );
  const executeWithFailover = vi.fn();
  const signer = {
    getAddress: vi.fn().mockResolvedValue(SIGNER),
    provider: {},
  } as unknown as ethers.Signer;
  return {
    adapter,
    getGasConfig,
    signer,
    rpcManager: { executeWithFailover } as unknown as RpcProviderManager,
    executeWithFailover,
  };
}

describe("EvmChainAdapter.executeContractCall at the next block", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSimulate.mockResolvedValue({
      gasEstimate: BigInt(46_097),
      simulation: SIMULATION,
    });
    mockSubmit.mockResolvedValue({ hash: "0xtxhash", response: {} });
  });

  it("simulates against the next block, sends with that estimate and reports it", async () => {
    const { adapter, getGasConfig, signer, rpcManager, executeWithFailover } =
      setup();
    const confirm = vi
      .spyOn(
        EvmChainAdapter.prototype as unknown as {
          confirmTransaction: () => Promise<unknown>;
        },
        "confirmTransaction"
      )
      .mockResolvedValue(RECEIPT);

    const receipt = await adapter.executeContractCall(
      signer,
      { contractAddress: TARGET, abi: ABI, functionKey: "run", args: [5] },
      {} as never,
      {
        gasOverrides: {},
        rpcManager,
        simulation: { timestampOffsetSec: 12 },
      }
    );

    const data = new ethers.Interface(ABI).encodeFunctionData("run", [5]);
    expect(mockSimulate).toHaveBeenCalledWith(rpcManager, {
      chainId: CHAIN_ID,
      tx: { from: SIGNER, to: TARGET, data, value: undefined },
      options: { timestampOffsetSec: 12 },
    });
    // No staticCall or estimate at `latest` on this path.
    expect(executeWithFailover).not.toHaveBeenCalled();
    expect(getGasConfig.mock.calls[0]?.[1]).toBe(BigInt(46_097));
    expect(mockSubmit.mock.calls[0]?.[1]).toMatchObject({
      to: TARGET,
      data,
      nonce: 7,
      gasLimit: BigInt(70_000),
      chainId: CHAIN_ID,
    });
    expect(receipt).toEqual({ ...RECEIPT, simulation: SIMULATION });
    confirm.mockRestore();
  });

  it("sends nothing when the next-block simulation reverts", async () => {
    const { adapter, signer, rpcManager } = setup();
    mockSimulate.mockRejectedValue(
      Object.assign(new Error("execution reverted"), { code: "CALL_EXCEPTION" })
    );

    await expect(
      adapter.executeContractCall(
        signer,
        { contractAddress: TARGET, abi: ABI, functionKey: "run", args: [5] },
        {} as never,
        { gasOverrides: {}, rpcManager, simulation: {} }
      )
    ).rejects.toMatchObject({ code: "CALL_EXCEPTION" });
    expect(mockSubmit).not.toHaveBeenCalled();
  });
});
