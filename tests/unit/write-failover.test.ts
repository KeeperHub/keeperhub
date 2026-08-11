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

import type { NonceSession } from "@/lib/web3/nonce-manager";
import { NonceConflictError } from "@/lib/web3/submit-signed";
import {
  type SubmitAndConfirmOptions,
  submitAndConfirm,
  submitContractCallAndConfirm,
} from "@/lib/web3/transaction-manager";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockReceipt(hash: string): ethers.TransactionReceipt {
  return {
    hash,
    gasUsed: BigInt(21_000),
    gasPrice: BigInt(10_000_000_000),
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
