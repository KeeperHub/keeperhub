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

import { broadcastStoredTempoTx } from "@/plugins/tempo/steps/tempo-tx-core";

const NOW_SEC = 1_800_000_000;
const CHAIN = 42_431;
const mockSend = vi.fn();
const WINDOW_CLOSED_RE = /validity window closed/;
const HASH_MISMATCH_RE = /does not match its expected hash/;
const NOT_TEMPO_RE = /not a Tempo network/;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW_SEC * 1000);
  mockGetRpcProvider.mockResolvedValue({
    executeWithFailover: (fn: (p: unknown) => unknown) =>
      Promise.resolve(fn({ send: (...a: unknown[]) => mockSend(...a) })),
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

  it("rejects a non-Tempo chain before touching the blob", async () => {
    await expect(
      broadcastStoredTempoTx({ chainId: 1, serialized: "0x76blob" })
    ).rejects.toThrow(NOT_TEMPO_RE);
    expect(mockDeserialize).not.toHaveBeenCalled();
  });
});
