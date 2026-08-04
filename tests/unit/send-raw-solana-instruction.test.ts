import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { getChainAdapter } from "@/lib/web3/chain-adapter";
import { resolveOrganizationContext } from "@/lib/web3/resolve-org-context";
import { initializeSolanaWallet } from "@/lib/web3/wallet-helpers";
import { sendRawSolanaInstructionCore } from "@/plugins/web3/steps/send-raw-solana-instruction-core";

vi.mock("@/lib/web3/wallet-helpers", () => ({
  initializeSolanaWallet: vi.fn(),
}));

vi.mock("@/lib/web3/chain-adapter", () => ({
  getChainAdapter: vi.fn(),
}));

vi.mock("@/lib/web3/resolve-org-context", () => ({
  resolveOrganizationContext: vi.fn(),
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { VALIDATION: "validation", TRANSACTION: "transaction" },
  logUserError: vi.fn(),
}));

// The org wallet / fee payer.
const WALLET = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const PROGRAM = new PublicKey("Stake11111111111111111111111111111111111111");
const ACCOUNT_A = new PublicKey("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");

function instruction(overrides: Record<string, unknown> = {}) {
  return {
    programId: PROGRAM.toBase58(),
    accounts: [
      { pubkey: ACCOUNT_A.toBase58(), isSigner: false, isWritable: true },
    ],
    data: Buffer.from([1, 2, 3]).toString("base64"),
    ...overrides,
  };
}

function decodeSentTransaction(sendTransaction: ReturnType<typeof vi.fn>) {
  const request = sendTransaction.mock.calls[0][1];
  return Transaction.from(Buffer.from(request.data, "base64"));
}

describe("sendRawSolanaInstructionCore", () => {
  let mockAdapter: {
    sendTransaction: ReturnType<typeof vi.fn>;
    getTransactionUrl: ReturnType<typeof vi.fn>;
  };

  const validInput = {
    network: "solana-devnet",
    instructions: JSON.stringify([instruction()]),
    maxSol: "1",
    _context: { organizationId: "mock-org-id" },
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockAdapter = {
      sendTransaction: vi.fn().mockResolvedValue({
        hash: "mock-signature",
        gasUsed: BigInt(4521),
        effectiveGasPrice: BigInt(10),
      }),
      getTransactionUrl: vi
        .fn()
        .mockResolvedValue("https://solscan.io/tx/mock-signature"),
    };

    vi.mocked(getChainAdapter).mockReturnValue(mockAdapter as never);
    vi.mocked(resolveOrganizationContext).mockResolvedValue({
      success: true,
      organizationId: "mock-org-id",
      userId: "mock-user-id",
    } as never);
    vi.mocked(initializeSolanaWallet).mockResolvedValue({
      signer: { getPublicKey: vi.fn(), signTransaction: vi.fn() },
      address: WALLET.toBase58(),
    } as never);
  });

  it("builds and submits a single instruction", async () => {
    const result = await sendRawSolanaInstructionCore(validInput);

    expect(result).toMatchObject({
      success: true,
      transactionHash: "mock-signature",
      transactionLink: "https://solscan.io/tx/mock-signature",
      gasUsedUnits: "4521",
      effectiveGasPrice: "10",
      instructionCount: 1,
    });

    const tx = decodeSentTransaction(mockAdapter.sendTransaction);
    expect(tx.instructions).toHaveLength(1);
    expect(tx.instructions[0].programId.equals(PROGRAM)).toBe(true);
    expect(tx.instructions[0].keys[0].pubkey.equals(ACCOUNT_A)).toBe(true);
    expect(tx.instructions[0].keys[0].isWritable).toBe(true);
    expect(Buffer.from(tx.instructions[0].data)).toEqual(
      Buffer.from([1, 2, 3])
    );
    expect(tx.feePayer?.equals(WALLET)).toBe(true);
    expect(tx.recentBlockhash).toBe(PublicKey.default.toBase58());
  });

  it("never passes gas overrides, so the normalizer cannot rewrite the tx as v0", async () => {
    await sendRawSolanaInstructionCore(validInput);

    const options = mockAdapter.sendTransaction.mock.calls[0][3];
    expect(options.gasOverrides).toEqual({});
  });

  it("rejects when maxSol is missing", async () => {
    const { maxSol: _maxSol, ...withoutMaxSol } = validInput;
    const result = await sendRawSolanaInstructionCore(withoutMaxSol);

    expect(result).toEqual({
      success: false,
      error: expect.stringContaining("maxSol is required"),
    });
    expect(mockAdapter.sendTransaction).not.toHaveBeenCalled();
  });

  it("accepts the org wallet as an isSigner account", async () => {
    const result = await sendRawSolanaInstructionCore({
      ...validInput,
      instructions: JSON.stringify([
        instruction({
          accounts: [
            { pubkey: WALLET.toBase58(), isSigner: true, isWritable: true },
          ],
        }),
      ]),
    });

    expect(result.success).toBe(true);
  });

  it("rejects a non-wallet isSigner account without submitting", async () => {
    const result = await sendRawSolanaInstructionCore({
      ...validInput,
      instructions: JSON.stringify([
        instruction({
          accounts: [
            { pubkey: ACCOUNT_A.toBase58(), isSigner: true, isWritable: true },
          ],
        }),
      ]),
    });

    expect(result).toMatchObject({ success: false });
    expect((result as { error: string }).error).toContain(
      "only the organization wallet"
    );
    expect(mockAdapter.sendTransaction).not.toHaveBeenCalled();
  });

  it("rejects a foreign signer in a non-first instruction", async () => {
    // The first instruction is clean; the foreign signer is in the second, so
    // findForeignSigner must scan past instruction 0.
    const result = await sendRawSolanaInstructionCore({
      ...validInput,
      instructions: JSON.stringify([
        instruction(),
        instruction({
          accounts: [
            { pubkey: ACCOUNT_A.toBase58(), isSigner: true, isWritable: false },
          ],
        }),
      ]),
    });

    expect(result).toMatchObject({ success: false });
    expect((result as { error: string }).error).toContain(
      "only the organization wallet"
    );
    expect(mockAdapter.sendTransaction).not.toHaveBeenCalled();
  });

  it("accepts instructions as a native array, not only a JSON string", async () => {
    const result = await sendRawSolanaInstructionCore({
      ...validInput,
      instructions: [instruction()],
    });

    expect(result.success).toBe(true);
  });

  it("accepts 0x-hex instruction data", async () => {
    const result = await sendRawSolanaInstructionCore({
      ...validInput,
      instructions: JSON.stringify([instruction({ data: "0x010203" })]),
    });

    expect(result.success).toBe(true);
    const tx = decodeSentTransaction(mockAdapter.sendTransaction);
    expect(Buffer.from(tx.instructions[0].data)).toEqual(
      Buffer.from([1, 2, 3])
    );
  });

  it("submits multiple instructions in order", async () => {
    const result = await sendRawSolanaInstructionCore({
      ...validInput,
      instructions: JSON.stringify([
        instruction({ data: Buffer.from([1]).toString("base64") }),
        instruction({ data: Buffer.from([2]).toString("base64") }),
      ]),
    });

    expect(result).toMatchObject({ success: true, instructionCount: 2 });
    const tx = decodeSentTransaction(mockAdapter.sendTransaction);
    expect(tx.instructions).toHaveLength(2);
  });

  it("rejects a non-Solana network without touching the adapter", async () => {
    const result = await sendRawSolanaInstructionCore({
      ...validInput,
      network: "ethereum",
    });

    expect(result).toMatchObject({ success: false });
    expect((result as { error: string }).error).toContain(
      "only supported on Solana networks"
    );
    expect(getChainAdapter).not.toHaveBeenCalled();
  });

  it("rejects an empty instructions array", async () => {
    const result = await sendRawSolanaInstructionCore({
      ...validInput,
      instructions: "[]",
    });

    expect(result).toEqual({
      success: false,
      error: "At least one instruction is required",
    });
  });

  it("rejects more than the instruction cap", async () => {
    const result = await sendRawSolanaInstructionCore({
      ...validInput,
      instructions: JSON.stringify(
        Array.from({ length: 11 }, () => instruction())
      ),
    });

    expect(result).toMatchObject({ success: false });
    expect((result as { error: string }).error).toContain(
      "Too many instructions"
    );
  });

  it("rejects instructions that are not valid JSON", async () => {
    const result = await sendRawSolanaInstructionCore({
      ...validInput,
      instructions: "{not json",
    });

    expect(result).toMatchObject({ success: false });
    expect((result as { error: string }).error).toContain("not valid JSON");
  });

  it("rejects an invalid programId", async () => {
    const result = await sendRawSolanaInstructionCore({
      ...validInput,
      instructions: JSON.stringify([
        instruction({ programId: "not-base58!!" }),
      ]),
    });

    expect(result).toMatchObject({ success: false });
    expect((result as { error: string }).error).toContain("Invalid programId");
  });

  it("rejects an invalid account pubkey", async () => {
    const result = await sendRawSolanaInstructionCore({
      ...validInput,
      instructions: JSON.stringify([
        instruction({
          accounts: [{ pubkey: "nope!!", isSigner: false, isWritable: true }],
        }),
      ]),
    });

    expect(result).toMatchObject({ success: false });
    expect((result as { error: string }).error).toContain(
      "Invalid account pubkey"
    );
  });

  it("rejects instruction data that is neither base64 nor 0x-hex", async () => {
    const result = await sendRawSolanaInstructionCore({
      ...validInput,
      instructions: JSON.stringify([instruction({ data: "0xZZ" })]),
    });

    expect(result).toMatchObject({ success: false });
    expect((result as { error: string }).error).toContain(
      "not valid standard base64 or 0x-hex"
    );
  });

  it("rejects a transaction that exceeds the size cap", async () => {
    // A single instruction whose data alone blows past the 1232-byte packet
    // limit, so the built transaction is rejected before submitting.
    const bigData = Buffer.alloc(1300, 7).toString("base64");
    const result = await sendRawSolanaInstructionCore({
      ...validInput,
      instructions: JSON.stringify([instruction({ data: bigData })]),
    });

    expect(result).toMatchObject({ success: false });
    expect((result as { error: string }).error).toContain(
      "Transaction too large"
    );
    expect(mockAdapter.sendTransaction).not.toHaveBeenCalled();
  });

  it("requires an execution or organization context", async () => {
    const result = await sendRawSolanaInstructionCore({
      ...validInput,
      _context: undefined,
    });

    expect(result).toMatchObject({ success: false });
    expect((result as { error: string }).error).toContain(
      "Execution ID or organization ID is required"
    );
  });

  it("returns a clean error when the submit fails", async () => {
    mockAdapter.sendTransaction.mockRejectedValue(
      new Error("Simulation failed")
    );

    const result = await sendRawSolanaInstructionCore(validInput);

    expect(result).toMatchObject({ success: false });
    expect((result as { error: string }).error).toContain("Simulation failed");
  });

  it("rejects malformed base64 that would silently truncate", async () => {
    // "A" passes the base64 charset but is not a complete group; Buffer.from
    // decodes it to zero bytes. The lossless round-trip check must reject it
    // rather than submit an unintended empty-data instruction.
    const result = await sendRawSolanaInstructionCore({
      ...validInput,
      instructions: JSON.stringify([instruction({ data: "A" })]),
    });

    expect(result).toMatchObject({ success: false });
    expect((result as { error: string }).error).toContain(
      "not valid standard base64 or 0x-hex"
    );
    expect(mockAdapter.sendTransaction).not.toHaveBeenCalled();
  });

  it("accepts base64 with internal whitespace (line-wrapped)", async () => {
    const canonical = Buffer.from([1, 2, 3, 4, 5, 6]).toString("base64");
    const wrapped = `${canonical.slice(0, 4)}\n${canonical.slice(4)}`;
    const result = await sendRawSolanaInstructionCore({
      ...validInput,
      instructions: JSON.stringify([instruction({ data: wrapped })]),
    });

    expect(result.success).toBe(true);
    const tx = decodeSentTransaction(mockAdapter.sendTransaction);
    expect(Buffer.from(tx.instructions[0].data)).toEqual(
      Buffer.from([1, 2, 3, 4, 5, 6])
    );
  });

  it("accepts an instruction with empty data", async () => {
    const result = await sendRawSolanaInstructionCore({
      ...validInput,
      instructions: JSON.stringify([instruction({ data: "" })]),
    });

    expect(result.success).toBe(true);
    const tx = decodeSentTransaction(mockAdapter.sendTransaction);
    expect(tx.instructions[0].data).toHaveLength(0);
  });

  it("rejects when the compiled transaction overflows even though data fits", async () => {
    // Data (1000 bytes) is under the 1232 pre-check, but 25 account keys push
    // the serialized message past the packet limit, so serialize() throws and
    // the translating catch reports it as a size overflow.
    const accounts = Array.from({ length: 25 }, () => ({
      pubkey: Keypair.generate().publicKey.toBase58(),
      isSigner: false,
      isWritable: false,
    }));
    const result = await sendRawSolanaInstructionCore({
      ...validInput,
      instructions: JSON.stringify([
        instruction({
          accounts,
          data: Buffer.alloc(1000, 9).toString("base64"),
        }),
      ]),
    });

    expect(result).toMatchObject({ success: false });
    expect((result as { error: string }).error).toContain(
      "too large to serialize"
    );
    expect(mockAdapter.sendTransaction).not.toHaveBeenCalled();
  });

  it("reports the index of a non-first invalid instruction", async () => {
    const result = await sendRawSolanaInstructionCore({
      ...validInput,
      instructions: JSON.stringify([
        instruction(),
        instruction({ programId: "not-base58!!" }),
      ]),
    });

    expect(result).toMatchObject({ success: false });
    expect((result as { error: string }).error).toContain("instruction 1");
  });
});
