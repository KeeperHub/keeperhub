import type { ethers } from "ethers";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks -- must be declared before importing the module under test
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));

vi.mock("drizzle-orm", () => ({
  eq: () => ({}),
}));

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      explorerConfigs: {
        findFirst: vi.fn().mockResolvedValue({
          chainId: 1,
          explorerUrl: "https://etherscan.io",
          explorerTxPath: "/tx/{hash}",
        }),
      },
    },
  },
}));

vi.mock("@/lib/db/schema", () => ({
  explorerConfigs: { chainId: "chainId" },
}));

vi.mock("@/lib/explorer", () => ({
  getTransactionUrl: (_config: unknown, hash: string): string =>
    `https://etherscan.io/tx/${hash}`,
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { TRANSACTION: "transaction" },
  logUserError: vi.fn(),
}));

vi.mock("@/lib/web3/wallet-helpers", () => ({
  initializeWalletSigner: vi.fn(),
}));

vi.mock("@/lib/rpc/provider-factory", () => ({
  getRpcProviderFromUrls: vi.fn(),
}));

const mockRecordTransaction = vi.fn().mockResolvedValue(undefined);
const mockConfirmTransaction = vi.fn().mockResolvedValue(undefined);
const mockGetNextNonce = vi.fn().mockReturnValue(42);

vi.mock("@/lib/web3/nonce-manager", () => ({
  getNonceManager: () => ({
    getNextNonce: mockGetNextNonce,
    recordTransaction: mockRecordTransaction,
    confirmTransaction: mockConfirmTransaction,
    startSession: vi.fn(),
    endSession: vi.fn(),
  }),
}));

vi.mock("@/lib/web3/gas-strategy", () => ({
  getGasStrategy: vi.fn(),
}));

const mockSubmitSigned = vi.hoisted(() => vi.fn());

vi.mock("@/lib/web3/submit-signed", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/web3/submit-signed")
  >("@/lib/web3/submit-signed");
  return {
    ...actual,
    submitSignedTransactionWithFailover: mockSubmitSigned,
  };
});

// ---------------------------------------------------------------------------
// Import module under test AFTER mocks
// ---------------------------------------------------------------------------

import { logUserError } from "@/lib/logging";
import { getGasStrategy } from "@/lib/web3/gas-strategy";
import type { NonceSession } from "@/lib/web3/nonce-manager";
import { NonceConflictError } from "@/lib/web3/submit-signed";
import {
  executeContractTransaction,
  executeTransaction,
  type SubmitAndConfirmOptions,
  submitAndConfirm,
  submitContractCallAndConfirm,
  type TransactionContext,
} from "@/lib/web3/transaction-manager";
import { initializeWalletSigner } from "@/lib/web3/wallet-helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockReceipt(hash: string, status = 1): ethers.TransactionReceipt {
  return {
    hash,
    status,
    gasUsed: BigInt(21_000),
    gasPrice: BigInt(10_000_000_000),
    blockNumber: 500,
  } as unknown as ethers.TransactionReceipt;
}

function makeMockTxResponse(hash: string): ethers.TransactionResponse {
  return { hash } as unknown as ethers.TransactionResponse;
}

function makeSession(): NonceSession {
  return {
    walletAddress: "0xABCD",
    chainId: 1,
    executionId: "exec-1",
    currentNonce: 42,
    startedAt: new Date(),
  };
}

function makeRpcManager(waitReceipt?: ethers.TransactionReceipt | null) {
  const executeWithFailover = vi
    .fn()
    .mockImplementation(
      async (
        op: (p: ethers.JsonRpcProvider) => Promise<unknown>,
        _opType: string
      ) => {
        const provider = {
          estimateGas: vi.fn().mockResolvedValue(BigInt(50_000)),
          waitForTransaction: vi
            .fn()
            .mockImplementation((hash: string) =>
              Promise.resolve(
                waitReceipt === undefined ? makeMockReceipt(hash) : waitReceipt
              )
            ),
        } as unknown as ethers.JsonRpcProvider;
        return await op(provider);
      }
    );
  return {
    executeWithFailover,
  } as unknown as SubmitAndConfirmOptions["rpcManager"];
}

function makeOptions(
  overrides?: Partial<SubmitAndConfirmOptions>
): SubmitAndConfirmOptions {
  return {
    rpcManager: makeRpcManager(),
    session: makeSession(),
    nonce: 42,
    workflowId: "wf-1",
    chainId: 1,
    maxFeePerGas: BigInt(20_000_000_000),
    ...overrides,
  };
}

function makeContext(
  rpcManager: TransactionContext["rpcManager"]
): TransactionContext {
  return {
    organizationId: "org-1",
    executionId: "exec-1",
    workflowId: "wf-1",
    chainId: 1,
    rpcUrl: "https://rpc.example",
    rpcManager,
  };
}

function makeContract(): ethers.Contract {
  return {
    runner: { provider: {}, signTransaction: vi.fn() },
    connect: () => ({
      getFunction: () => ({
        estimateGas: vi.fn().mockResolvedValue(BigInt(50_000)),
      }),
    }),
    interface: { encodeFunctionData: vi.fn().mockReturnValue("0xencodeddata") },
    getAddress: vi.fn().mockResolvedValue("0xcontract"),
  } as unknown as ethers.Contract;
}

function stubSignerAndGas(): void {
  vi.mocked(initializeWalletSigner).mockResolvedValue({
    provider: {},
  } as never);
  vi.mocked(getGasStrategy).mockReturnValue({
    getGasConfig: vi.fn().mockResolvedValue({
      gasLimit: BigInt(100_000),
      maxFeePerGas: BigInt(20_000_000_000),
      maxPriorityFeePerGas: BigInt(1_000_000_000),
    }),
  } as never);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("submitAndConfirm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes broadcast through submitSignedTransactionWithFailover and returns built result", async () => {
    mockSubmitSigned.mockResolvedValue({
      hash: "0xhash1",
      response: makeMockTxResponse("0xhash1"),
    });
    const signer = {} as ethers.Signer;
    const options = makeOptions();

    const result = await submitAndConfirm(
      signer as never,
      { to: "0xrecipient", value: BigInt(1000), nonce: 42 },
      options
    );

    expect(mockSubmitSigned).toHaveBeenCalledWith(
      signer,
      { to: "0xrecipient", value: BigInt(1000), nonce: 42 },
      options.rpcManager
    );
    expect(result.txHash).toBe("0xhash1");
    expect(result.gasCostWei).toBe(
      (BigInt(21_000) * BigInt(10_000_000_000)).toString()
    );
    expect(result.transactionLink).toContain("0xhash1");
    expect(mockRecordTransaction).toHaveBeenCalledOnce();
    expect(mockConfirmTransaction).toHaveBeenCalledOnce();
  });

  it("uses preExistingReceipt and skips waitForTransaction when helper found tx already mined", async () => {
    const preReceipt = makeMockReceipt("0xhash-mined");
    mockSubmitSigned.mockResolvedValue({
      hash: "0xhash-mined",
      response: makeMockTxResponse("0xhash-mined"),
      preExistingReceipt: preReceipt,
    });
    const options = makeOptions();
    const waitSpy = options.rpcManager.executeWithFailover as ReturnType<
      typeof vi.fn
    >;

    const result = await submitAndConfirm(
      {} as never,
      { to: "0xrecipient", value: BigInt(0), nonce: 42 },
      options
    );

    expect(result.txHash).toBe("0xhash-mined");
    expect(waitSpy).not.toHaveBeenCalled();
    expect(mockConfirmTransaction).toHaveBeenCalledWith("0xhash-mined");
  });

  it("propagates NonceConflictError from the helper without recording", async () => {
    const conflictErr = new NonceConflictError(
      "0xhashlost",
      42,
      new Error("nonce too low")
    );
    mockSubmitSigned.mockRejectedValue(conflictErr);

    await expect(
      submitAndConfirm(
        {} as never,
        { to: "0xrecipient", value: BigInt(0), nonce: 42 },
        makeOptions()
      )
    ).rejects.toBe(conflictErr);

    expect(mockRecordTransaction).not.toHaveBeenCalled();
    expect(mockConfirmTransaction).not.toHaveBeenCalled();
  });

  it("throws when waitForTransaction resolves null (receipt unavailable)", async () => {
    mockSubmitSigned.mockResolvedValue({
      hash: "0xhash1",
      response: makeMockTxResponse("0xhash1"),
    });
    const options = makeOptions(undefined);
    options.rpcManager = makeRpcManager(null);

    await expect(
      submitAndConfirm(
        {} as never,
        { to: "0xrecipient", value: BigInt(0), nonce: 42 },
        options
      )
    ).rejects.toThrow("receipt not available");
  });

  it("throws and leaves the nonce unconfirmed when the mined receipt has status 0", async () => {
    mockSubmitSigned.mockResolvedValue({
      hash: "0xreverted",
      response: makeMockTxResponse("0xreverted"),
    });
    const options = makeOptions(undefined);
    options.rpcManager = makeRpcManager(makeMockReceipt("0xreverted", 0));

    await expect(
      submitAndConfirm(
        {} as never,
        { to: "0xrecipient", value: BigInt(0), nonce: 42 },
        options
      )
    ).rejects.toThrow(
      "Transaction 0xreverted reverted on-chain (status 0, block 500)"
    );

    expect(mockConfirmTransaction).not.toHaveBeenCalled();
  });
});

describe("submitContractCallAndConfirm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("encodes calldata and forwards a fully-populated txRequest to the helper", async () => {
    mockSubmitSigned.mockResolvedValue({
      hash: "0xhash-c1",
      response: makeMockTxResponse("0xhash-c1"),
    });
    const encodeFunctionData = vi.fn().mockReturnValue("0xencodeddata");
    const getAddress = vi.fn().mockResolvedValue("0xcontract");
    const contract = {
      interface: { encodeFunctionData },
      getAddress,
    } as unknown as ethers.Contract;
    const signer = {} as ethers.Signer;
    const options = makeOptions();

    const result = await submitContractCallAndConfirm(
      contract,
      "transfer",
      ["0xrecipient", BigInt(1000)],
      { nonce: 42, gasLimit: BigInt(50_000) },
      signer as never,
      options
    );

    expect(encodeFunctionData).toHaveBeenCalledWith("transfer", [
      "0xrecipient",
      BigInt(1000),
    ]);
    expect(getAddress).toHaveBeenCalledOnce();
    expect(mockSubmitSigned).toHaveBeenCalledWith(
      signer,
      {
        to: "0xcontract",
        data: "0xencodeddata",
        nonce: 42,
        gasLimit: BigInt(50_000),
      },
      options.rpcManager
    );
    expect(result.txHash).toBe("0xhash-c1");
  });

  it("propagates NonceConflictError from helper", async () => {
    mockSubmitSigned.mockRejectedValue(
      new NonceConflictError("0xhashlost", 42, new Error("nonce too low"))
    );
    const contract = {
      interface: { encodeFunctionData: vi.fn().mockReturnValue("0xdata") },
      getAddress: vi.fn().mockResolvedValue("0xcontract"),
    } as unknown as ethers.Contract;

    await expect(
      submitContractCallAndConfirm(
        contract,
        "approve",
        [],
        { nonce: 42 },
        {} as never,
        makeOptions()
      )
    ).rejects.toBeInstanceOf(NonceConflictError);
  });
});

describe("executeTransaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubSignerAndGas();
  });

  it("returns success: false and leaves the nonce unconfirmed when the mined receipt has status 0", async () => {
    mockSubmitSigned.mockResolvedValue({
      hash: "0xreverted",
      response: makeMockTxResponse("0xreverted"),
    });
    const rpcManager = makeRpcManager(makeMockReceipt("0xreverted", 0));

    const result = await executeTransaction(
      makeContext(rpcManager),
      "0xABCD",
      () => ({ to: "0xrecipient", value: BigInt(0) }),
      makeSession()
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe(
      "Transaction 0xreverted reverted on-chain (status 0, block 500)"
    );
    expect(result.nonce).toBe(42);
    expect(mockRecordTransaction).toHaveBeenCalledOnce();
    expect(mockConfirmTransaction).not.toHaveBeenCalled();
    expect(logUserError).toHaveBeenCalledOnce();
  });

  it("treats a status-0 preExistingReceipt from broadcast reconciliation as a revert", async () => {
    mockSubmitSigned.mockResolvedValue({
      hash: "0xreverted",
      response: makeMockTxResponse("0xreverted"),
      preExistingReceipt: makeMockReceipt("0xreverted", 0),
    });
    const rpcManager = makeRpcManager();

    const result = await executeTransaction(
      makeContext(rpcManager),
      "0xABCD",
      () => ({ to: "0xrecipient", value: BigInt(0) }),
      makeSession()
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("reverted on-chain (status 0");
    expect(mockConfirmTransaction).not.toHaveBeenCalled();
  });

  it("returns success: true with the receipt for a status-1 receipt", async () => {
    mockSubmitSigned.mockResolvedValue({
      hash: "0xmined",
      response: makeMockTxResponse("0xmined"),
    });
    const rpcManager = makeRpcManager(makeMockReceipt("0xmined", 1));

    const result = await executeTransaction(
      makeContext(rpcManager),
      "0xABCD",
      () => ({ to: "0xrecipient", value: BigInt(0) }),
      makeSession()
    );

    expect(result.success).toBe(true);
    expect(result.txHash).toBe("0xmined");
    expect(result.receipt?.status).toBe(1);
    expect(mockConfirmTransaction).toHaveBeenCalledWith("0xmined");
  });

  it("returns success: false rather than a receiptless success when the receipt is null", async () => {
    mockSubmitSigned.mockResolvedValue({
      hash: "0xunread",
      response: makeMockTxResponse("0xunread"),
    });
    const rpcManager = makeRpcManager(null);

    const result = await executeTransaction(
      makeContext(rpcManager),
      "0xABCD",
      () => ({ to: "0xrecipient", value: BigInt(0) }),
      makeSession()
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("Transaction sent but receipt not available");
    expect(mockConfirmTransaction).not.toHaveBeenCalled();
  });
});

describe("executeContractTransaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubSignerAndGas();
  });

  it("returns success: false and leaves the nonce unconfirmed when the mined receipt has status 0", async () => {
    mockSubmitSigned.mockResolvedValue({
      hash: "0xreverted",
      response: makeMockTxResponse("0xreverted"),
    });
    const rpcManager = makeRpcManager(makeMockReceipt("0xreverted", 0));

    const result = await executeContractTransaction(
      makeContext(rpcManager),
      "0xABCD",
      makeContract(),
      "transfer",
      ["0xrecipient", BigInt(1000)],
      makeSession()
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe(
      "Transaction 0xreverted reverted on-chain (status 0, block 500)"
    );
    expect(mockConfirmTransaction).not.toHaveBeenCalled();
    expect(logUserError).toHaveBeenCalledOnce();
  });

  it("returns success: true for a status-1 receipt", async () => {
    mockSubmitSigned.mockResolvedValue({
      hash: "0xmined",
      response: makeMockTxResponse("0xmined"),
    });
    const rpcManager = makeRpcManager(makeMockReceipt("0xmined", 1));

    const result = await executeContractTransaction(
      makeContext(rpcManager),
      "0xABCD",
      makeContract(),
      "transfer",
      ["0xrecipient", BigInt(1000)],
      makeSession()
    );

    expect(result.success).toBe(true);
    expect(result.txHash).toBe("0xmined");
    expect(mockConfirmTransaction).toHaveBeenCalledWith("0xmined");
  });

  it("treats a status-0 preExistingReceipt from broadcast reconciliation as a revert", async () => {
    mockSubmitSigned.mockResolvedValue({
      hash: "0xreverted",
      response: makeMockTxResponse("0xreverted"),
      preExistingReceipt: makeMockReceipt("0xreverted", 0),
    });
    const rpcManager = makeRpcManager();

    const result = await executeContractTransaction(
      makeContext(rpcManager),
      "0xABCD",
      makeContract(),
      "transfer",
      ["0xrecipient", BigInt(1000)],
      makeSession()
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("reverted on-chain (status 0");
    expect(mockConfirmTransaction).not.toHaveBeenCalled();
  });

  it("returns success: false rather than a receiptless success when the receipt is null", async () => {
    mockSubmitSigned.mockResolvedValue({
      hash: "0xunread",
      response: makeMockTxResponse("0xunread"),
    });
    const rpcManager = makeRpcManager(null);

    const result = await executeContractTransaction(
      makeContext(rpcManager),
      "0xABCD",
      makeContract(),
      "transfer",
      ["0xrecipient", BigInt(1000)],
      makeSession()
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe(
      "Contract transaction sent but receipt not available"
    );
    expect(mockConfirmTransaction).not.toHaveBeenCalled();
  });
});
