import { ethers } from "ethers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/logging", () => ({
  ErrorCategory: { NETWORK_RPC: "network_rpc" },
  logSystemError: vi.fn(),
  logSystemWarn: vi.fn(),
  logWarn: vi.fn(),
}));

const { mockBroadcastToBuilders } = vi.hoisted(() => ({
  mockBroadcastToBuilders: vi.fn(),
}));
vi.mock("@/lib/web3/builder-broadcast", () => ({
  broadcastToBuilders: (...args: unknown[]) => mockBroadcastToBuilders(...args),
}));

import type { RpcProviderManager } from "@/lib/rpc/providers";
import { OnChainPendingError } from "@/lib/web3/onchain-revert";
import { submitSignedTransactionWithFailover } from "@/lib/web3/submit-signed";

const TX_REQUEST: ethers.TransactionRequest = {
  to: "0x000000000000000000000000000000000000dEaD",
  nonce: 7,
  value: BigInt(0),
  gasLimit: BigInt(21_000),
  maxFeePerGas: BigInt(10_000_000_000),
  maxPriorityFeePerGas: BigInt(1_000_000_000),
  chainId: 1,
  type: 2,
};

const BUILDERS = { titan: "https://titan.example" };

let SIGNED_HEX: string;
let HASH: string;

beforeAll(async () => {
  const wallet = new ethers.Wallet(`0x${"2".repeat(64)}`);
  SIGNED_HEX = await wallet.signTransaction(TX_REQUEST);
  HASH = ethers.Transaction.from(SIGNED_HEX).hash ?? "";
});

function makeSigner(): ethers.Signer {
  return {
    populateTransaction: vi.fn().mockResolvedValue(TX_REQUEST),
    signTransaction: vi.fn().mockResolvedValue(SIGNED_HEX),
  } as unknown as ethers.Signer;
}

// Runs the broadcast on `active`; `fallback` is what the manager reports as
// its fallback provider.
function makeManager(
  active: { broadcastTransaction: ReturnType<typeof vi.fn> },
  fallback: unknown = null
): RpcProviderManager {
  return {
    executeWithFailover: vi.fn(
      async (op: (p: ethers.JsonRpcProvider) => Promise<unknown>) =>
        await op(active as unknown as ethers.JsonRpcProvider)
    ),
    getFallbackProvider: vi.fn().mockReturnValue(fallback),
  } as unknown as RpcProviderManager;
}

describe("submitSignedTransactionWithFailover broadcast info and builders", () => {
  beforeEach(() => {
    mockBroadcastToBuilders.mockReset();
  });

  it("reports the primary RPC and broadcast time, without builders by default", async () => {
    const provider = {
      broadcastTransaction: vi.fn().mockResolvedValue({ hash: HASH }),
    };

    const result = await submitSignedTransactionWithFailover(
      makeSigner(),
      TX_REQUEST,
      makeManager(provider)
    );

    expect(result.broadcast?.via).toBe("primary");
    expect(Number.isNaN(Date.parse(result.broadcast?.broadcastAt ?? ""))).toBe(
      false
    );
    expect(result.broadcast?.builders).toBeUndefined();
    expect(mockBroadcastToBuilders).not.toHaveBeenCalled();
  });

  it("reports the fallback RPC when the fallback provider sent it", async () => {
    const provider = {
      broadcastTransaction: vi.fn().mockResolvedValue({ hash: HASH }),
    };

    const result = await submitSignedTransactionWithFailover(
      makeSigner(),
      TX_REQUEST,
      makeManager(provider, provider)
    );

    expect(result.broadcast?.via).toBe("fallback");
  });

  it("sends the same signed bytes to the builders and reports their results", async () => {
    const provider = {
      broadcastTransaction: vi.fn().mockResolvedValue({ hash: HASH }),
    };
    mockBroadcastToBuilders.mockResolvedValue([
      { name: "titan", accepted: false, error: "busy" },
    ]);

    const result = await submitSignedTransactionWithFailover(
      makeSigner(),
      TX_REQUEST,
      makeManager(provider),
      { builderRpcUrls: BUILDERS }
    );

    expect(mockBroadcastToBuilders).toHaveBeenCalledWith(SIGNED_HEX, BUILDERS);
    expect(provider.broadcastTransaction).toHaveBeenCalledWith(SIGNED_HEX);
    expect(result.hash).toBe(HASH);
    expect(result.broadcast?.builders).toEqual([
      { name: "titan", accepted: false, error: "busy" },
    ]);
  });

  it("still reconciles a failed regular broadcast when builders were sent", async () => {
    const provider = {
      broadcastTransaction: vi.fn().mockRejectedValue(new Error("timeout")),
      getTransactionReceipt: vi.fn().mockResolvedValue(null),
      getTransaction: vi.fn().mockResolvedValue(null),
    };
    mockBroadcastToBuilders.mockResolvedValue([
      { name: "titan", accepted: true },
    ]);

    const error = await submitSignedTransactionWithFailover(
      makeSigner(),
      TX_REQUEST,
      makeManager(provider),
      { builderRpcUrls: BUILDERS }
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OnChainPendingError);
    expect((error as OnChainPendingError).transactionHash).toBe(HASH);
  });
});
