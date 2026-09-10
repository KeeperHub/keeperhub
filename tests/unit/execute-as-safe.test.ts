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
  getGasStrategy: () => ({
    getGasConfig: async () => ({
      gasLimit: BigInt(100_000),
      maxFeePerGas: BigInt(20_000_000_000),
      maxPriorityFeePerGas: BigInt(1_000_000_000),
    }),
  }),
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
});
