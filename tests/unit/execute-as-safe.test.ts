import type { ethers } from "ethers";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks - must be declared before importing the module under test
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  finishMetrics: vi.fn(),
  recordTransaction: vi.fn(),
  confirmTransaction: vi.fn(),
  submitSigned: vi.fn(),
  getGasConfig: vi.fn(),
}));

vi.mock("@/lib/metrics/instrumentation/safe", () => ({
  startSafeTxMetrics: () => mocks.finishMetrics,
}));

vi.mock("@/lib/safe/allowance-module", () => ({
  buildExecTransactionCalldata: () => "0xouter",
}));

vi.mock("@/lib/safe/zodiac-roles", () => ({
  buildExecTransactionWithRoleCalldata: () => "0xouter",
}));

vi.mock("@/lib/web3/nonce-manager", () => ({
  getNonceManager: () => ({
    getNextNonce: () => 42,
    recordTransaction: mocks.recordTransaction,
    confirmTransaction: mocks.confirmTransaction,
  }),
}));

vi.mock("@/lib/web3/gas-strategy", () => ({
  getGasStrategy: () => ({ getGasConfig: mocks.getGasConfig }),
}));

vi.mock("@/lib/web3/submit-signed", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/web3/submit-signed")
  >("@/lib/web3/submit-signed");
  return {
    ...actual,
    submitSignedTransactionWithFailover: mocks.submitSigned,
  };
});

const mockSimulateSend = vi.fn();
vi.mock("@/lib/web3/next-block-simulation", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/web3/next-block-simulation")
  >()),
  simulateSendAtNextBlock: (...args: unknown[]) => mockSimulateSend(...args),
}));

// ---------------------------------------------------------------------------
// Import module under test AFTER mocks
// ---------------------------------------------------------------------------

import {
  type ExecuteAsSafeOptions,
  executeContractCallAsRole,
  executeContractCallAsSafe,
  executeNativeTransferAsRole,
  executeNativeTransferAsSafe,
} from "@/lib/safe/execute-as-safe";
import type { NonceSession } from "@/lib/web3/nonce-manager";
import {
  broadcastTransactionHash,
  isOnChainPendingError,
  isOnChainRevertError,
} from "@/lib/web3/onchain-revert";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SAFE = "0x1111111111111111111111111111111111111111";
const OWNER = "0x2222222222222222222222222222222222222222";
const TARGET = "0x3333333333333333333333333333333333333333";
const RECIPIENT = "0x4444444444444444444444444444444444444444";
const MODIFIER = "0x5555555555555555555555555555555555555555";
const ROLE_KEY = `0x${"ab".repeat(32)}`;
const TX_HASH = "0xf00d";
const BLOCK = 500;
const ERC20_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)",
];

const signer = { provider: {} } as unknown as ethers.Signer;

const session: NonceSession = {
  walletAddress: OWNER,
  chainId: 1,
  executionId: "exec-1",
  currentNonce: 42,
  startedAt: new Date(),
};

function makeReceipt(status: number): ethers.TransactionReceipt {
  return {
    hash: TX_HASH,
    status,
    gasUsed: BigInt(90_000),
    gasPrice: BigInt(1_000_000_000),
    blockNumber: BLOCK,
  } as unknown as ethers.TransactionReceipt;
}

function makeRpcManager(receipt: ethers.TransactionReceipt | null): {
  options: ExecuteAsSafeOptions;
  waitForTransaction: ReturnType<typeof vi.fn>;
} {
  const waitForTransaction = vi.fn().mockResolvedValue(receipt);
  const provider = {
    estimateGas: vi.fn().mockResolvedValue(BigInt(50_000)),
    waitForTransaction,
  } as unknown as ethers.JsonRpcProvider;
  const rpcManager = {
    executeWithFailover: (
      op: (p: ethers.JsonRpcProvider) => Promise<unknown>
    ) => op(provider),
  } as unknown as ExecuteAsSafeOptions["rpcManager"];
  return {
    options: { chainId: 1, workflowId: "wf-1", rpcManager },
    waitForTransaction,
  };
}

/**
 * An rpcManager whose receipt wait rejects the way exhausting every provider
 * does (~186s of failover), while the pre-broadcast gas estimate still works.
 */
function makeExhaustedRpcManager(reason: Error): ExecuteAsSafeOptions {
  const provider = {
    estimateGas: vi.fn().mockResolvedValue(BigInt(50_000)),
    waitForTransaction: vi.fn().mockRejectedValue(reason),
  } as unknown as ethers.JsonRpcProvider;
  const rpcManager = {
    executeWithFailover: (
      op: (p: ethers.JsonRpcProvider) => Promise<unknown>
    ) => op(provider),
  } as unknown as ExecuteAsSafeOptions["rpcManager"];
  return { chainId: 1, workflowId: "wf-1", rpcManager };
}

type Invoke = (options: ExecuteAsSafeOptions) => Promise<unknown>;

const cases: [string, Invoke][] = [
  [
    "executeContractCallAsSafe",
    (options) =>
      executeContractCallAsSafe(
        signer,
        {
          safeAddress: SAFE,
          ownerAddress: OWNER,
          contractAddress: TARGET,
          abi: ERC20_ABI,
          functionKey: "transfer",
          args: [RECIPIENT, BigInt(1)],
        },
        session,
        options
      ),
  ],
  [
    "executeContractCallAsRole",
    (options) =>
      executeContractCallAsRole(
        signer,
        {
          safeAddress: SAFE,
          delegateAddress: OWNER,
          rolesModifierAddress: MODIFIER,
          roleKey: ROLE_KEY,
          contractAddress: TARGET,
          abi: ERC20_ABI,
          functionKey: "transfer",
          args: [RECIPIENT, BigInt(1)],
        },
        session,
        options
      ),
  ],
  [
    "executeNativeTransferAsRole",
    (options) =>
      executeNativeTransferAsRole(
        signer,
        {
          safeAddress: SAFE,
          delegateAddress: OWNER,
          rolesModifierAddress: MODIFIER,
          roleKey: ROLE_KEY,
          to: RECIPIENT,
          amount: BigInt(1),
        },
        session,
        options
      ),
  ],
  [
    "executeNativeTransferAsSafe",
    (options) =>
      executeNativeTransferAsSafe(
        signer,
        {
          safeAddress: SAFE,
          ownerAddress: OWNER,
          to: RECIPIENT,
          amount: BigInt(1),
        },
        session,
        options
      ),
  ],
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.each(cases)("%s", (_name, invoke) => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getGasConfig.mockResolvedValue({
      gasLimit: BigInt(100_000),
      maxFeePerGas: BigInt(20_000_000_000),
      maxPriorityFeePerGas: BigInt(1_000_000_000),
    });
    mocks.submitSigned.mockResolvedValue({
      hash: TX_HASH,
      response: { hash: TX_HASH },
    });
  });

  it("fails with OnChainRevertError when the mined receipt has status 0", async () => {
    const { options } = makeRpcManager(makeReceipt(0));

    const error: unknown = await invoke(options).catch((e: unknown) => e);

    expect(isOnChainRevertError(error)).toBe(true);
    expect(broadcastTransactionHash(error)).toBe(TX_HASH);
    expect((error as { blockNumber?: number }).blockNumber).toBe(BLOCK);
    expect((error as Error).message).toContain(
      `reverted on-chain (status 0, block ${BLOCK})`
    );
    expect(mocks.recordTransaction).toHaveBeenCalledOnce();
    expect(mocks.confirmTransaction).not.toHaveBeenCalled();
    expect(mocks.finishMetrics).toHaveBeenCalledWith("failure");
  });

  it("treats a status-0 receipt found during broadcast reconciliation as a revert", async () => {
    mocks.submitSigned.mockResolvedValue({
      hash: TX_HASH,
      response: { hash: TX_HASH },
      preExistingReceipt: makeReceipt(0),
    });
    const { options, waitForTransaction } = makeRpcManager(makeReceipt(1));

    const error: unknown = await invoke(options).catch((e: unknown) => e);

    expect(isOnChainRevertError(error)).toBe(true);
    expect(waitForTransaction).not.toHaveBeenCalled();
    expect(mocks.confirmTransaction).not.toHaveBeenCalled();
  });

  /**
   * KEEP-1281: both of these are post-broadcast. The transaction is on the
   * network and the nonce is spent, so a throw that drops the hash stamps a
   * terminal failure on a transaction that exists on-chain and nowhere in our
   * data -- the finalizer harvests the hash off the error, and there was none.
   *
   * OnChainPendingError, never OnChainRevertError: failing to READ a receipt
   * says nothing about whether the transaction succeeded.
   */
  it("carries the hash when the receipt wait exhausts every provider", async () => {
    const options = makeExhaustedRpcManager(new Error("all providers failed"));

    const error: unknown = await invoke(options).catch((e: unknown) => e);

    expect(isOnChainPendingError(error)).toBe(true);
    expect(broadcastTransactionHash(error)).toBe(TX_HASH);
    expect((error as Error).message).toContain(
      "sent but receipt could not be read"
    );
    expect((error as Error).message).toContain("all providers failed");
    expect(mocks.recordTransaction).toHaveBeenCalledOnce();
    expect(mocks.confirmTransaction).not.toHaveBeenCalled();
    expect(mocks.finishMetrics).toHaveBeenCalledWith("failure");
  });

  it("bounds the receipt wait instead of polling for blocks forever", async () => {
    const { options, waitForTransaction } = makeRpcManager(makeReceipt(1));

    await invoke(options);

    // ethers' waitForTransaction rejects only when a timeout is supplied and
    // otherwise waits on the block listener indefinitely, so without one a
    // Safe-routed transaction that never mines pins the step until the reaper
    // takes it and records no hash.
    const [hash, confirms, timeoutMs] = waitForTransaction.mock.calls[0] as [
      string,
      number,
      number,
    ];
    expect(hash).toBe(TX_HASH);
    expect(confirms).toBe(1);
    expect(timeoutMs).toBeGreaterThan(186_000);
    expect(timeoutMs).toBeLessThan(30 * 60 * 1000);
  });

  it("carries the hash when the wait resolves without a receipt", async () => {
    const { options } = makeRpcManager(null);

    const error: unknown = await invoke(options).catch((e: unknown) => e);

    expect(isOnChainPendingError(error)).toBe(true);
    expect(broadcastTransactionHash(error)).toBe(TX_HASH);
    expect((error as Error).message).toContain("sent but receipt unavailable");
    expect(mocks.confirmTransaction).not.toHaveBeenCalled();
  });

  it("returns the receipt and confirms the nonce for a status-1 receipt", async () => {
    const { options } = makeRpcManager(makeReceipt(1));

    const receipt = await invoke(options);

    expect(receipt).toEqual({
      hash: TX_HASH,
      gasUsed: BigInt(90_000),
      effectiveGasPrice: BigInt(1_000_000_000),
      blockNumber: BLOCK,
    });
    expect(mocks.confirmTransaction).toHaveBeenCalledWith(TX_HASH);
    expect(mocks.finishMetrics).toHaveBeenCalledWith("success");
  });

  it("passes the node's fee overrides to the gas strategy", async () => {
    const { options } = makeRpcManager(makeReceipt(1));
    const feeOverrides = {
      priorityFeeOverride: BigInt(2e9),
      maxFeeOverride: BigInt(40e9),
    };

    await invoke({ ...options, feeOverrides });

    const args = mocks.getGasConfig.mock.calls[0];
    expect(args?.[6]).toBe(feeOverrides.priorityFeeOverride);
    expect(args?.[7]).toBe(feeOverrides.maxFeeOverride);
  });
});

describe.each([
  ["executeContractCallAsSafe", cases[0][1], SAFE],
  ["executeContractCallAsRole", cases[1][1], MODIFIER],
] as const)("%s at the next block", (_name, invoke, outerTarget) => {
  const SIMULATION = {
    mode: "next-block",
    baseBlock: 100,
    assumedBlockNumber: 101,
    assumedTimestamp: 1_000_012,
    timestampOffsetSec: 12,
    rpcMethod: "eth_estimateGas+blockOverrides",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.submitSigned.mockResolvedValue({
      hash: TX_HASH,
      response: { hash: TX_HASH },
    });
    mockSimulateSend.mockResolvedValue({
      gasEstimate: BigInt(77_000),
      simulation: SIMULATION,
    });
  });

  it("estimates the outer transaction at the next block and reports it", async () => {
    const { options } = makeRpcManager(makeReceipt(1));
    const provider = await options.rpcManager.executeWithFailover(
      async (p) => p
    );

    const receipt = await invoke({ ...options, simulation: {} });

    expect(mockSimulateSend).toHaveBeenCalledWith(options.rpcManager, {
      chainId: 1,
      tx: { to: outerTarget, data: "0xouter", from: OWNER },
      options: {},
    });
    expect(provider.estimateGas).not.toHaveBeenCalled();
    expect(receipt).toMatchObject({ hash: TX_HASH, simulation: SIMULATION });
  });

  it("tags a failure after the check passed with the predicted block", async () => {
    mocks.submitSigned.mockRejectedValue(new Error("nonce too low"));
    const { options } = makeRpcManager(makeReceipt(1));

    const error = await invoke({ ...options, simulation: {} }).catch(
      (e: unknown) => e
    );

    expect(error).toMatchObject({
      message: "nonce too low",
      nextBlockSimulation: SIMULATION,
    });
  });

  it("tags an on-chain revert after the check passed", async () => {
    const { options } = makeRpcManager(makeReceipt(0));

    const error = await invoke({ ...options, simulation: {} }).catch(
      (e: unknown) => e
    );

    expect(isOnChainRevertError(error)).toBe(true);
    expect(error).toMatchObject({ nextBlockSimulation: SIMULATION });
  });

  it("sends nothing when the next-block estimate reverts", async () => {
    mockSimulateSend.mockRejectedValue(new Error("execution reverted"));
    const { options } = makeRpcManager(makeReceipt(1));

    await expect(invoke({ ...options, simulation: {} })).rejects.toThrow(
      "execution reverted"
    );
    expect(mocks.submitSigned).not.toHaveBeenCalled();
  });

  it("keeps the latest-block estimate without the option", async () => {
    const { options } = makeRpcManager(makeReceipt(1));

    const receipt = await invoke(options);

    expect(mockSimulateSend).not.toHaveBeenCalled();
    expect(receipt).not.toHaveProperty("simulation");
  });
});
