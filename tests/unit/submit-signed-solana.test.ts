import "server-only";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

import { Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import { submitSignedSolanaTransactionWithFailover } from "@/lib/web3/submit-signed-solana";

const MOCK_SIGNATURE =
  "4p2wE1oGvK8p1d2Fz3H4X5y6Z7W8v9u0v1x2y3z4A5B6C7D8E9F0G1H2I3J4K5L6M7N8O9P0Q1R2S3T4U5V6W7X8Y9Z";

describe("submitSignedSolanaTransactionWithFailover", () => {
  let mockConnection: any;
  let mockManager: any;
  let txBytes: Uint8Array;
  let senderKeypair: Keypair;
  let recipientKeypair: Keypair;

  beforeEach(() => {
    senderKeypair = Keypair.generate();
    recipientKeypair = Keypair.generate();

    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: senderKeypair.publicKey,
        toPubkey: recipientKeypair.publicKey,
        lamports: BigInt(1000),
      })
    );
    tx.feePayer = senderKeypair.publicKey;
    tx.recentBlockhash = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
    tx.sign(senderKeypair);
    txBytes = tx.serialize();

    mockConnection = {
      sendRawTransaction: vi.fn(),
      getSignatureStatuses: vi.fn(),
    };

    mockManager = {
      executeWithFailover: vi
        .fn()
        .mockImplementation((op) => op(mockConnection)),
    };
  });

  it("broadcasts successfully on first attempt", async () => {
    mockConnection.sendRawTransaction.mockResolvedValue("signature123");

    const result = await submitSignedSolanaTransactionWithFailover(
      txBytes,
      mockManager
    );

    expect(result.signature).toBeDefined();
    expect(mockConnection.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it("reconciles on duplicate transaction error and returns signature on confirmed status", async () => {
    mockConnection.sendRawTransaction.mockRejectedValue(
      new Error("This transaction has already been processed")
    );
    mockConnection.getSignatureStatuses.mockResolvedValue({
      value: [{ confirmationStatus: "confirmed", err: null }],
    });

    const result = await submitSignedSolanaTransactionWithFailover(
      txBytes,
      mockManager
    );

    expect(result.signature).toBeDefined();
    expect(mockConnection.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(mockConnection.getSignatureStatuses).toHaveBeenCalledTimes(1);
  });

  it("re-throws original error if duplicate transaction is not confirmed or found on-chain", async () => {
    mockConnection.sendRawTransaction.mockRejectedValue(
      new Error("already processed")
    );
    mockConnection.getSignatureStatuses.mockResolvedValue({
      value: [null],
    });

    await expect(
      submitSignedSolanaTransactionWithFailover(txBytes, mockManager)
    ).rejects.toThrow("already processed");

    expect(mockConnection.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(mockConnection.getSignatureStatuses).toHaveBeenCalledTimes(1);
  });

  it("re-throws other broadcast failures directly without reconciling", async () => {
    mockConnection.sendRawTransaction.mockRejectedValue(
      new Error("BlockhashNotFound")
    );

    await expect(
      submitSignedSolanaTransactionWithFailover(txBytes, mockManager)
    ).rejects.toThrow("BlockhashNotFound");

    expect(mockConnection.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(mockConnection.getSignatureStatuses).not.toHaveBeenCalled();
  });
});
