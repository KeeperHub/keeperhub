import "server-only";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

import {
  Keypair,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  RECONCILE_ATTEMPTS,
  submitSignedSolanaTransactionWithFailover,
} from "@/lib/web3/submit-signed-solana";

// Reconciliation sleeps between polls in production; tests drive it with a
// zero delay so they assert the polling behaviour without paying for it.
const NO_DELAY = { delayMs: 0 } as const;

const _MOCK_SIGNATURE =
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
      submitSignedSolanaTransactionWithFailover(txBytes, mockManager, NO_DELAY)
    ).rejects.toThrow("already processed");

    expect(mockConnection.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(mockConnection.getSignatureStatuses).toHaveBeenCalledTimes(
      RECONCILE_ATTEMPTS
    );
  });

  it("reconciles on any broadcast error and rethrows when the tx never landed", async () => {
    // A non-duplicate error (timeout, or an RPC-side rejection). The signed
    // bytes are always reconcilable, so the status is checked; a null status
    // means the tx never landed, so the original error is rethrown.
    mockConnection.sendRawTransaction.mockRejectedValue(
      new Error("BlockhashNotFound")
    );
    mockConnection.getSignatureStatuses.mockResolvedValue({ value: [null] });

    await expect(
      submitSignedSolanaTransactionWithFailover(txBytes, mockManager, NO_DELAY)
    ).rejects.toThrow("BlockhashNotFound");

    expect(mockConnection.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(mockConnection.getSignatureStatuses).toHaveBeenCalledTimes(
      RECONCILE_ATTEMPTS
    );
  });

  it("returns success when the signature confirms on a later poll", async () => {
    // A transaction the RPC accepted needs a slot or two before it is
    // queryable. Concluding "never landed" from one immediate lookup lets the
    // caller re-sign under a fresh blockhash, producing a second transaction
    // with its own signature that can land alongside the first.
    mockConnection.sendRawTransaction.mockRejectedValue(
      new Error("Request timed out")
    );
    mockConnection.getSignatureStatuses
      .mockResolvedValueOnce({ value: [null] })
      .mockResolvedValueOnce({
        value: [{ confirmationStatus: "processed", err: null }],
      })
      .mockResolvedValue({
        value: [{ confirmationStatus: "confirmed", err: null }],
      });

    const result = await submitSignedSolanaTransactionWithFailover(
      txBytes,
      mockManager,
      NO_DELAY
    );

    expect(result.signature).toBeDefined();
    expect(mockConnection.getSignatureStatuses).toHaveBeenCalledTimes(3);
  });

  it("keeps polling when a status read fails on every endpoint", async () => {
    mockConnection.sendRawTransaction.mockRejectedValue(
      new Error("Request timed out")
    );
    mockConnection.getSignatureStatuses
      .mockRejectedValueOnce(new Error("all endpoints down"))
      .mockResolvedValue({
        value: [{ confirmationStatus: "confirmed", err: null }],
      });

    const result = await submitSignedSolanaTransactionWithFailover(
      txBytes,
      mockManager,
      NO_DELAY
    );

    expect(result.signature).toBeDefined();
    expect(mockConnection.getSignatureStatuses).toHaveBeenCalledTimes(2);
  });

  it("recovers a timeout as success when the tx actually finalized", async () => {
    mockConnection.sendRawTransaction.mockRejectedValue(
      new Error("Request timed out")
    );
    mockConnection.getSignatureStatuses.mockResolvedValue({
      value: [{ confirmationStatus: "finalized", err: null }],
    });

    const result = await submitSignedSolanaTransactionWithFailover(
      txBytes,
      mockManager
    );

    expect(result.signature).toBeDefined();
    expect(mockConnection.getSignatureStatuses).toHaveBeenCalledTimes(1);
  });

  it("rethrows when the reconciled tx is confirmed but has an execution error", async () => {
    mockConnection.sendRawTransaction.mockRejectedValue(
      new Error("already been processed")
    );
    mockConnection.getSignatureStatuses.mockResolvedValue({
      value: [
        {
          confirmationStatus: "confirmed",
          err: { InstructionError: [0, "Custom"] },
        },
      ],
    });

    await expect(
      submitSignedSolanaTransactionWithFailover(txBytes, mockManager, NO_DELAY)
    ).rejects.toThrow("already been processed");

    // An explicit on-chain error is a final answer, so polling stops there
    // rather than burning the remaining attempts.
    expect(mockConnection.getSignatureStatuses).toHaveBeenCalledTimes(1);
  });

  it("rethrows when the reconciled tx is only at 'processed' commitment", async () => {
    mockConnection.sendRawTransaction.mockRejectedValue(
      new Error("already been processed")
    );
    mockConnection.getSignatureStatuses.mockResolvedValue({
      value: [{ confirmationStatus: "processed", err: null }],
    });

    await expect(
      submitSignedSolanaTransactionWithFailover(txBytes, mockManager, NO_DELAY)
    ).rejects.toThrow("already been processed");
  });

  it("rethrows the original error when signed bytes cannot be parsed", async () => {
    mockConnection.sendRawTransaction.mockRejectedValue(
      new Error("broadcast failed")
    );

    await expect(
      submitSignedSolanaTransactionWithFailover(
        new Uint8Array([0xff, 0x00, 0x01]),
        mockManager
      )
    ).rejects.toThrow("broadcast failed");

    expect(mockConnection.getSignatureStatuses).not.toHaveBeenCalled();
  });

  it("reconciles versioned transaction broadcast errors by signature", async () => {
    const payer = Keypair.generate();
    const recipient = Keypair.generate();
    const message = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      instructions: [
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: recipient.publicKey,
          lamports: BigInt(1000),
        }),
      ],
    }).compileToV0Message();
    const versionedTx = new VersionedTransaction(message);
    versionedTx.sign([payer]);
    const versionedBytes = versionedTx.serialize();

    mockConnection.sendRawTransaction.mockRejectedValue(
      new Error("already been processed")
    );
    mockConnection.getSignatureStatuses.mockResolvedValue({
      value: [{ confirmationStatus: "confirmed", err: null }],
    });

    const result = await submitSignedSolanaTransactionWithFailover(
      versionedBytes,
      mockManager
    );

    expect(result.signature).toBeDefined();
    expect(mockConnection.getSignatureStatuses).toHaveBeenCalledTimes(1);
  });
});
