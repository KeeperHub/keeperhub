import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/turnkey/turnkey-client", () => ({
  getTurnkeySignerConfig: vi.fn(),
}));
vi.mock("@/lib/safe/signer-resolver", () => ({
  resolveSignerMode: vi.fn(),
  SIGNER_MODE: { EOA: "eoa", SAFE: "safe", SAFE_ROLE: "safe-role" },
}));
vi.mock("@/lib/web3/wallet-helpers", () => ({
  getOrganizationWallet: vi.fn(),
}));
vi.mock("@/lib/logging", () => ({
  ErrorCategory: { TRANSACTION: "transaction" },
  logSystemError: vi.fn(),
  logUserError: vi.fn(),
}));

const mockGetRpcProvider = vi.fn();
vi.mock("@/lib/rpc/provider-factory", () => ({
  getRpcProvider: (...args: unknown[]) => mockGetRpcProvider(...args),
}));

const mockDeserialize = vi.fn();
const mockHash = vi.fn();
vi.mock("ox/tempo", () => ({
  TxEnvelopeTempo: {
    deserialize: (...args: unknown[]) => mockDeserialize(...args),
    hash: (...args: unknown[]) => mockHash(...args),
  },
}));

import { isOnChainPendingError } from "@/lib/web3/onchain-revert";
import { broadcastStoredTempoTx } from "@/plugins/tempo/steps/tempo-tx-core";

const NOW_SEC = 1_800_000_000;
const CHAIN = 42_431;
const mockSend = vi.fn();
const mockGetTransaction = vi.fn();
const WINDOW_CLOSED_RE = /validity window closed/;
const HASH_MISMATCH_RE = /does not match its expected hash/;
const NOT_TEMPO_RE = /not a Tempo network/;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW_SEC * 1000);
  mockGetTransaction.mockResolvedValue(null);
  mockGetRpcProvider.mockResolvedValue({
    executeWithFailover: (fn: (p: unknown) => unknown) =>
      Promise.resolve(
        fn({
          send: (...a: unknown[]) => mockSend(...a),
          getTransaction: (...a: unknown[]) => mockGetTransaction(...a),
        })
      ),
    getProvider: () => ({}),
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("broadcastStoredTempoTx", () => {
  it("refuses a blob whose validity window has already closed", async () => {
    mockDeserialize.mockReturnValue({ validBefore: NOW_SEC - 100 });
    await expect(
      broadcastStoredTempoTx({ chainId: CHAIN, serialized: "0x76blob" })
    ).rejects.toThrow(WINDOW_CLOSED_RE);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("refuses a blob that does not match its expected hash", async () => {
    mockDeserialize.mockReturnValue({ validBefore: NOW_SEC + 100 });
    mockHash.mockReturnValue("0xdifferent");
    await expect(
      broadcastStoredTempoTx({
        chainId: CHAIN,
        serialized: "0x76blob",
        expectedHash: "0xhash",
      })
    ).rejects.toThrow(HASH_MISMATCH_RE);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("sends without waiting when waitForConfirmation is false", async () => {
    mockDeserialize.mockReturnValue({ validBefore: NOW_SEC + 100 });
    mockSend.mockResolvedValue("0xsent");

    const res = await broadcastStoredTempoTx({
      chainId: CHAIN,
      serialized: "0x76blob",
      waitForConfirmation: false,
    });

    expect(res).toEqual({ hash: "0xsent", confirmed: false });
    expect(mockSend).toHaveBeenCalledWith("eth_sendRawTransaction", [
      "0x76blob",
    ]);
  });

  it("treats a node funding-shortfall rejection as terminal, not pending", async () => {
    // The node read the envelope and refused it: nothing was broadcast.
    // Wrapping this in OnChainPendingError would record a hash that is not
    // on chain, which reconcile reads as pending forever.
    mockDeserialize.mockReturnValue({ validBefore: NOW_SEC + 100 });
    mockHash.mockReturnValue("0xhash");
    const nodeError = new Error("insufficient funds for gas * price + value");
    mockSend.mockRejectedValue(nodeError);

    const thrown = await broadcastStoredTempoTx({
      chainId: CHAIN,
      serialized: "0x76blob",
      waitForConfirmation: false,
    }).then(
      () => undefined,
      (error: unknown) => error
    );

    expect(thrown).toBe(nodeError);
    expect(isOnChainPendingError(thrown)).toBe(false);
  });

  it("treats an intrinsic-gas rejection as terminal, not pending", async () => {
    mockDeserialize.mockReturnValue({ validBefore: NOW_SEC + 100 });
    mockHash.mockReturnValue("0xhash");
    const nodeError = new Error(
      "intrinsic gas too low: have 21000, want 53000"
    );
    mockSend.mockRejectedValue(nodeError);

    const thrown = await broadcastStoredTempoTx({
      chainId: CHAIN,
      serialized: "0x76blob",
      waitForConfirmation: false,
    }).then(
      () => undefined,
      (error: unknown) => error
    );

    expect(thrown).toBe(nodeError);
    expect(isOnChainPendingError(thrown)).toBe(false);
  });

  it("still carries the hash as pending when the send outcome is unreadable", async () => {
    mockDeserialize.mockReturnValue({ validBefore: NOW_SEC + 100 });
    mockHash.mockReturnValue("0xhash");
    mockSend.mockRejectedValue(new Error("request timed out"));

    const thrown = await broadcastStoredTempoTx({
      chainId: CHAIN,
      serialized: "0x76blob",
      waitForConfirmation: false,
    }).then(
      () => undefined,
      (error: unknown) => error
    );

    expect(isOnChainPendingError(thrown)).toBe(true);
    expect((thrown as { transactionHash?: string }).transactionHash).toBe(
      "0xhash"
    );
  });

  it("keeps a send pending when earlier retry history was not all refusals", async () => {
    mockDeserialize.mockReturnValue({ validBefore: NOW_SEC + 100 });
    mockHash.mockReturnValue("0xhash");
    const masked = Object.assign(
      new Error(
        "RPC failed on both endpoints. Primary: ECONNREFUSED. Fallback: ECONNREFUSED"
      ),
      { allAttemptsConnectionRefused: false }
    );
    mockSend.mockRejectedValue(masked);

    const thrown = await broadcastStoredTempoTx({
      chainId: CHAIN,
      serialized: "0x76blob",
      waitForConfirmation: false,
    }).then(
      () => undefined,
      (error: unknown) => error
    );

    expect(isOnChainPendingError(thrown)).toBe(true);
    expect((thrown as { transactionHash?: string }).transactionHash).toBe(
      "0xhash"
    );
    expect(mockGetTransaction).not.toHaveBeenCalled();
  });

  it("treats an all-refused send as accepted when its deterministic hash is visible", async () => {
    mockDeserialize.mockReturnValue({ validBefore: NOW_SEC + 100 });
    mockHash.mockReturnValue("0xhash");
    const refused = Object.assign(new Error("ECONNREFUSED"), {
      allAttemptsConnectionRefused: true,
    });
    mockSend.mockRejectedValue(refused);
    mockGetTransaction.mockResolvedValue({ hash: "0xhash" });

    const result = await broadcastStoredTempoTx({
      chainId: CHAIN,
      serialized: "0x76blob",
      waitForConfirmation: false,
    });

    expect(result).toEqual({ hash: "0xhash", confirmed: false });
    expect(mockGetTransaction).toHaveBeenCalledWith("0xhash");
  });

  it("keeps an all-refused send terminal only after a readable hash miss", async () => {
    mockDeserialize.mockReturnValue({ validBefore: NOW_SEC + 100 });
    mockHash.mockReturnValue("0xhash");
    const refused = Object.assign(new Error("ECONNREFUSED"), {
      allAttemptsConnectionRefused: true,
    });
    mockSend.mockRejectedValue(refused);
    mockGetTransaction.mockResolvedValue(null);

    const thrown = await broadcastStoredTempoTx({
      chainId: CHAIN,
      serialized: "0x76blob",
      waitForConfirmation: false,
    }).then(
      () => undefined,
      (error: unknown) => error
    );

    expect(thrown).toBe(refused);
    expect(isOnChainPendingError(thrown)).toBe(false);
    expect(mockGetTransaction).toHaveBeenCalledWith("0xhash");
  });

  it("rejects a non-Tempo chain before touching the blob", async () => {
    await expect(
      broadcastStoredTempoTx({ chainId: 1, serialized: "0x76blob" })
    ).rejects.toThrow(NOT_TEMPO_RE);
    expect(mockDeserialize).not.toHaveBeenCalled();
  });
});
