import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  ACCOUNT_SIZE,
  AccountLayout,
  AccountState,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  ExtensionType,
  getAssociatedTokenAddressSync,
  getMintLen,
  MINT_SIZE,
  MintLayout,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { getChainAdapter } from "@/lib/web3/chain-adapter";
import { resolveOrganizationContext } from "@/lib/web3/resolve-org-context";
import { initializeSolanaWallet } from "@/lib/web3/wallet-helpers";
import {
  isSplTransferPath,
  transferSplTokenCore,
} from "@/plugins/web3/steps/transfer-spl-token-core";

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

// The transfer authority / fee payer. Fixed keys keep derived ATAs stable.
const OWNER = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const RECIPIENT = new PublicKey("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");
const MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

const RENT_LAMPORTS = 2_039_280;
const BASE_FEE = 5000;

/** SPL TokenInstruction discriminators. */
const IX_TRANSFER = 3;
const IX_TRANSFER_CHECKED = 12;

type MockAccount = {
  owner: PublicKey;
  data: Buffer;
  lamports?: number;
} | null;

/** A funded system account, for the owner slot of the preflight batch read. */
function systemAccount(lamports: number): MockAccount {
  return { owner: PublicKey.default, data: Buffer.alloc(0), lamports };
}

function mintAccount(
  decimals: number,
  programId = TOKEN_PROGRAM_ID
): MockAccount {
  const data = Buffer.alloc(MINT_SIZE);
  MintLayout.encode(
    {
      mintAuthorityOption: 1,
      mintAuthority: OWNER,
      supply: BigInt(1_000_000_000),
      decimals,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    data
  );
  return { owner: programId, data };
}

/**
 * A Token-2022 mint carrying a single extension. Only the TLV type header needs
 * to be well-formed for getExtensionTypes to recognise it; the value is zeroed.
 */
function mintWithExtension(
  decimals: number,
  extension: ExtensionType
): MockAccount {
  const data = Buffer.alloc(getMintLen([extension]));
  MintLayout.encode(
    {
      mintAuthorityOption: 1,
      mintAuthority: OWNER,
      supply: BigInt(1_000_000_000),
      decimals,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    data
  );
  // TLV after the padded base mint: [accountType u8][type u16][len u16][value].
  data.writeUInt8(1, ACCOUNT_SIZE); // AccountType.Mint
  data.writeUInt16LE(extension, ACCOUNT_SIZE + 1); // extension type
  data.writeUInt16LE(
    getMintLen([extension]) - ACCOUNT_SIZE - 5,
    ACCOUNT_SIZE + 3
  ); // value length
  return { owner: TOKEN_2022_PROGRAM_ID, data };
}

function tokenAccount(
  amount: bigint,
  mint = MINT,
  owner = OWNER,
  programId = TOKEN_PROGRAM_ID
): MockAccount {
  const data = Buffer.alloc(ACCOUNT_SIZE);
  AccountLayout.encode(
    {
      mint,
      owner,
      amount,
      delegateOption: 0,
      delegate: PublicKey.default,
      delegatedAmount: BigInt(0),
      state: AccountState.Initialized,
      isNativeOption: 0,
      isNative: BigInt(0),
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    data
  );
  return { owner: programId, data };
}

function decodeSentTransaction(sendTransaction: ReturnType<typeof vi.fn>) {
  const request = sendTransaction.mock.calls[0][1];
  return Transaction.from(Buffer.from(request.data, "base64"));
}

describe("transferSplTokenCore", () => {
  let mockAdapter: {
    sendTransaction: ReturnType<typeof vi.fn>;
    getTransactionUrl: ReturnType<typeof vi.fn>;
    executeWithSolanaFailover: ReturnType<typeof vi.fn>;
  };
  let mockConnection: {
    getAccountInfo: ReturnType<typeof vi.fn>;
    getMultipleAccountsInfo: ReturnType<typeof vi.fn>;
    getMinimumBalanceForRentExemption: ReturnType<typeof vi.fn>;
  };

  const validInput = {
    network: "solana-devnet",
    mint: MINT.toBase58(),
    recipientAddress: RECIPIENT.toBase58(),
    amount: "1.5",
    _context: { organizationId: "mock-org-id" },
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockConnection = {
      getAccountInfo: vi.fn().mockResolvedValue(mintAccount(6)),
      getMultipleAccountsInfo: vi
        .fn()
        // [senderAta, recipientAta, recipientWallet, ownerWallet]
        .mockResolvedValue([
          tokenAccount(BigInt(10_000_000)),
          tokenAccount(BigInt(0), MINT, RECIPIENT),
          null,
          systemAccount(2_000_000_000),
        ]),
      getMinimumBalanceForRentExemption: vi
        .fn()
        .mockResolvedValue(RENT_LAMPORTS),
    };

    mockAdapter = {
      sendTransaction: vi.fn().mockResolvedValue({
        hash: "mock-signature",
        gasUsed: BigInt(4521), // compute units
        effectiveGasPrice: BigInt(10), // micro-lamports
      }),
      getTransactionUrl: vi
        .fn()
        .mockResolvedValue("https://solscan.io/tx/mock-signature"),
      executeWithSolanaFailover: vi.fn((operation) =>
        operation(mockConnection)
      ),
    };

    vi.mocked(getChainAdapter).mockReturnValue(mockAdapter as never);
    vi.mocked(resolveOrganizationContext).mockResolvedValue({
      success: true,
      organizationId: "mock-org-id",
      userId: "mock-user-id",
    } as never);
    vi.mocked(initializeSolanaWallet).mockResolvedValue({
      signer: { getPublicKey: vi.fn(), signTransaction: vi.fn() },
      address: OWNER.toBase58(),
    } as never);
  });

  it("identifies Solana chain IDs", () => {
    expect(isSplTransferPath(101)).toBe(true); // Solana Mainnet
    expect(isSplTransferPath(103)).toBe(true); // Solana Devnet
    expect(isSplTransferPath(1)).toBe(false); // EVM Ethereum
    expect(isSplTransferPath(8453)).toBe(false); // EVM Base
  });

  it("transfers when the recipient token account already exists", async () => {
    const result = await transferSplTokenCore(validInput);

    expect(result).toMatchObject({
      success: true,
      transactionHash: "mock-signature",
      transactionLink: "https://solscan.io/tx/mock-signature",
      amount: "1.5",
      mint: MINT.toBase58(),
      decimals: 6,
      recipient: RECIPIENT.toBase58(),
      createdRecipientAccount: false,
      gasUsed: "5000",
      gasUsedUnits: "4521",
      effectiveGasPrice: "10",
    });

    const tx = decodeSentTransaction(mockAdapter.sendTransaction);
    expect(tx.instructions).toHaveLength(1);
    expect(tx.feePayer?.equals(OWNER)).toBe(true);
  });

  it("sets the placeholder blockhash and owner fee payer, which the adapter overwrites", async () => {
    await transferSplTokenCore(validInput);

    const tx = decodeSentTransaction(mockAdapter.sendTransaction);
    // Serializing requires both; the adapter replaces the blockhash before
    // signing. If this fails, check that nobody "fixed" the placeholder.
    expect(tx.recentBlockhash).toBe(PublicKey.default.toBase58());
    expect(tx.feePayer?.equals(OWNER)).toBe(true);
  });

  it("never passes gas overrides, so the normalizer cannot rewrite the tx as v0", async () => {
    await transferSplTokenCore(validInput);

    const options = mockAdapter.sendTransaction.mock.calls[0][3];
    expect(options.gasOverrides).toEqual({});
    expect(options.gasOverrides.gasLimitOverride).toBeUndefined();
    expect(options.gasOverrides.priorityFeeOverride).toBeUndefined();
  });

  it("uses transferChecked rather than transfer", async () => {
    await transferSplTokenCore(validInput);

    const tx = decodeSentTransaction(mockAdapter.sendTransaction);
    const transferIx = tx.instructions.at(-1);
    expect(transferIx?.data[0]).toBe(IX_TRANSFER_CHECKED);
    expect(transferIx?.data[0]).not.toBe(IX_TRANSFER);
  });

  it("derives the amount from the mint's decimals, not a fixed value", async () => {
    // 1.5 at 6 decimals = 1_500_000 raw units, encoded LE after the discriminator.
    await transferSplTokenCore(validInput);

    const tx = decodeSentTransaction(mockAdapter.sendTransaction);
    const transferIx = tx.instructions.at(-1);
    expect(transferIx?.data.readBigUInt64LE(1)).toBe(BigInt(1_500_000));
    expect(transferIx?.data[9]).toBe(6); // decimals byte
  });

  it("creates the recipient token account when it is missing, using Token-2022", async () => {
    mockConnection.getAccountInfo.mockResolvedValue(
      mintAccount(9, TOKEN_2022_PROGRAM_ID)
    );
    mockConnection.getMultipleAccountsInfo.mockResolvedValue([
      tokenAccount(BigInt(10_000_000_000), MINT, OWNER, TOKEN_2022_PROGRAM_ID),
      null, // recipient ATA missing
      null,
      systemAccount(2_000_000_000),
    ]);

    const result = await transferSplTokenCore(validInput);

    expect(result).toMatchObject({
      success: true,
      createdRecipientAccount: true,
    });

    const tx = decodeSentTransaction(mockAdapter.sendTransaction);
    expect(tx.instructions).toHaveLength(2);
    // The idempotent create must come first, or the transfer hits a missing account.
    expect(
      tx.instructions[0].programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)
    ).toBe(true);
    expect(tx.instructions[1].programId.equals(TOKEN_2022_PROGRAM_ID)).toBe(
      true
    );
    // Rent must be sized for a Token-2022 ATA including the ImmutableOwner the
    // ATA program adds (170 bytes), not the bare 165-byte account.
    expect(
      mockConnection.getMinimumBalanceForRentExemption
    ).toHaveBeenCalledWith(170);
  });

  it("routes to the token program that owns the mint", async () => {
    mockConnection.getAccountInfo.mockResolvedValue(
      mintAccount(6, TOKEN_2022_PROGRAM_ID)
    );
    mockConnection.getMultipleAccountsInfo.mockResolvedValue([
      tokenAccount(BigInt(10_000_000), MINT, OWNER, TOKEN_2022_PROGRAM_ID),
      tokenAccount(BigInt(0), MINT, RECIPIENT, TOKEN_2022_PROGRAM_ID),
      null,
      systemAccount(2_000_000_000),
    ]);

    const result = await transferSplTokenCore(validInput);
    expect(result.success).toBe(true);

    const tx = decodeSentTransaction(mockAdapter.sendTransaction);
    expect(tx.instructions[0].programId.equals(TOKEN_2022_PROGRAM_ID)).toBe(
      true
    );

    // The recipient ATA must be derived under the same program.
    const expectedAta = getAssociatedTokenAddressSync(
      MINT,
      RECIPIENT,
      true,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    expect(
      (result as { recipientTokenAccount: string }).recipientTokenAccount
    ).toBe(expectedAta.toBase58());
  });

  it("rejects a non-Solana network without touching RPC", async () => {
    const result = await transferSplTokenCore({
      ...validInput,
      network: "ethereum",
    });

    expect(result).toEqual({
      success: false,
      error: expect.stringContaining("only supported on Solana networks"),
    });
    expect(mockAdapter.executeWithSolanaFailover).not.toHaveBeenCalled();
  });

  it("rejects an invalid mint address without touching RPC", async () => {
    const result = await transferSplTokenCore({
      ...validInput,
      mint: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // an ERC20 address
    });

    expect(result).toEqual({
      success: false,
      error: expect.stringContaining("Invalid Solana mint address"),
    });
    expect(mockAdapter.executeWithSolanaFailover).not.toHaveBeenCalled();
  });

  it("rejects an invalid recipient address without touching RPC", async () => {
    const result = await transferSplTokenCore({
      ...validInput,
      recipientAddress: "not-a-real-address",
    });

    expect(result).toEqual({
      success: false,
      error: expect.stringContaining("Invalid Solana recipient address"),
    });
    expect(mockAdapter.executeWithSolanaFailover).not.toHaveBeenCalled();
  });

  it("reports a missing mint account", async () => {
    mockConnection.getAccountInfo.mockResolvedValue(null);

    const result = await transferSplTokenCore(validInput);

    expect(result).toEqual({
      success: false,
      error: expect.stringContaining("Mint account not found"),
    });
  });

  it("rejects a mint owned by neither token program", async () => {
    mockConnection.getAccountInfo.mockResolvedValue({
      owner: Keypair.generate().publicKey,
      data: Buffer.alloc(MINT_SIZE),
    });

    const result = await transferSplTokenCore(validInput);

    expect(result).toEqual({
      success: false,
      error: expect.stringContaining("is not an SPL token mint"),
    });
  });

  it("rejects a transfer-fee mint rather than misreport the amount", async () => {
    // The recipient of a fee mint receives less than the requested amount, which
    // the step cannot report without reading the fee, so it declines the mint.
    mockConnection.getAccountInfo.mockResolvedValue(
      mintWithExtension(6, ExtensionType.TransferFeeConfig)
    );

    const result = await transferSplTokenCore(validInput);

    expect(result).toMatchObject({ success: false });
    expect((result as { error: string }).error).toContain("transfer fee");
    expect(mockAdapter.sendTransaction).not.toHaveBeenCalled();
  });

  it("returns a clean error when the mint account is malformed", async () => {
    // A token account address pasted into the mint field: owned by the token
    // program (so isTokenProgram passes), but unpackMint throws. The step must
    // return a clean error, not reject with an uncaught exception.
    mockConnection.getAccountInfo.mockResolvedValue(
      tokenAccount(BigInt(1), MINT, OWNER)
    );

    const result = await transferSplTokenCore(validInput);

    expect(result).toMatchObject({ success: false });
    expect((result as { error: string }).error).toContain(
      "is not a valid SPL mint"
    );
  });

  it("reports when the sending wallet has no token account for the mint", async () => {
    mockConnection.getMultipleAccountsInfo.mockResolvedValue([
      null,
      null,
      null,
    ]);

    const result = await transferSplTokenCore(validInput);

    expect(result).toEqual({
      success: false,
      error: expect.stringContaining("no token account for mint"),
    });
  });

  it("reports insufficient token balance", async () => {
    mockConnection.getMultipleAccountsInfo.mockResolvedValue([
      tokenAccount(BigInt(1_000_000)), // 1.0 held, 1.5 requested
      tokenAccount(BigInt(0), MINT, RECIPIENT),
      null,
    ]);

    const result = await transferSplTokenCore(validInput);

    expect(result).toEqual({
      success: false,
      error: expect.stringContaining("Insufficient token balance"),
    });
  });

  it("rejects a recipient that is itself a token account", async () => {
    mockConnection.getMultipleAccountsInfo.mockResolvedValue([
      tokenAccount(BigInt(10_000_000)),
      null,
      tokenAccount(BigInt(0), MINT, RECIPIENT), // the recipient address IS a token account
    ]);

    const result = await transferSplTokenCore(validInput);

    expect(result).toEqual({
      success: false,
      error: expect.stringContaining(
        "must be a wallet address, not a token account"
      ),
    });
  });

  it("reports insufficient SOL for the transaction fee", async () => {
    // Recipient ATA exists (no rent); owner cannot even cover the fee.
    mockConnection.getMultipleAccountsInfo.mockResolvedValue([
      tokenAccount(BigInt(10_000_000)),
      tokenAccount(BigInt(0), MINT, RECIPIENT),
      null,
      systemAccount(BASE_FEE - 1),
    ]);

    const result = await transferSplTokenCore(validInput);

    expect(result).toEqual({
      success: false,
      error: expect.stringContaining("Insufficient SOL balance"),
    });
  });

  it("reserves rent on top of the fee when creating the recipient account", async () => {
    // Covers the fee but not the fee plus rent - the case unique to this path.
    mockConnection.getMultipleAccountsInfo.mockResolvedValue([
      tokenAccount(BigInt(10_000_000)),
      null, // recipient ATA missing -> rent required
      null,
      systemAccount(BASE_FEE + 1),
    ]);

    const result = await transferSplTokenCore(validInput);

    expect(result).toMatchObject({ success: false });
    expect((result as { error: string }).error).toContain(
      "Insufficient SOL balance"
    );
    expect((result as { error: string }).error).toContain("rent");
    // Fee alone would have passed; rent is what makes it fail.
    expect((result as { error: string }).error).toContain(
      String(BASE_FEE + RENT_LAMPORTS)
    );
  });

  it("refuses a mint whose rent exceeds what the spend cap reserved", async () => {
    // The daily Solana cap is charged a fixed worst case before the step runs,
    // since the reservation makes no chain read. A mint whose token account is
    // large enough - Token-2022 with several extensions - needs more rent than
    // that. Spending it anyway would put real SOL outflow above what the ledger
    // recorded, so the transfer has to stop here even though the wallet could
    // afford it.
    mockConnection.getMultipleAccountsInfo.mockResolvedValue([
      tokenAccount(BigInt(10_000_000)),
      null, // recipient ATA missing -> rent required
      null,
      systemAccount(100_000_000), // plenty of SOL
    ]);
    mockConnection.getMinimumBalanceForRentExemption.mockResolvedValue(
      5_000_000
    );

    const result = await transferSplTokenCore(validInput);

    expect(result).toMatchObject({ success: false });
    expect((result as { error: string }).error).toContain(
      "reserved against the organization's daily Solana spending cap"
    );
  });

  it("does not charge rent when the recipient account already exists", async () => {
    // Recipient ATA exists, so only the fee is required and no rent is read.
    mockConnection.getMultipleAccountsInfo.mockResolvedValue([
      tokenAccount(BigInt(10_000_000)),
      tokenAccount(BigInt(0), MINT, RECIPIENT),
      null,
      systemAccount(BASE_FEE),
    ]);

    const result = await transferSplTokenCore(validInput);

    expect(result.success).toBe(true);
    expect(
      mockConnection.getMinimumBalanceForRentExemption
    ).not.toHaveBeenCalled();
  });

  it("returns a clean error when the mint read fails", async () => {
    mockConnection.getAccountInfo.mockRejectedValue(new Error("RPC down"));

    const result = await transferSplTokenCore(validInput);

    expect(result).toEqual({
      success: false,
      error: expect.stringContaining("Failed to read mint account"),
    });
  });

  it("returns a clean error when the transaction fails to send", async () => {
    mockAdapter.sendTransaction.mockRejectedValue(
      new Error("Simulation failed")
    );

    const result = await transferSplTokenCore(validInput);

    expect(result).toEqual({
      success: false,
      error: expect.stringContaining("Simulation failed"),
    });
  });

  it("requires an execution or organization context", async () => {
    const result = await transferSplTokenCore({
      ...validInput,
      _context: undefined,
    });

    expect(result).toEqual({
      success: false,
      error: expect.stringContaining(
        "Execution ID or organization ID is required"
      ),
    });
  });

  it("rejects an empty amount", async () => {
    const result = await transferSplTokenCore({ ...validInput, amount: "  " });

    expect(result).toEqual({ success: false, error: "Amount is required" });
  });

  it("rejects an unparseable amount", async () => {
    const result = await transferSplTokenCore({ ...validInput, amount: "abc" });

    expect(result).toEqual({
      success: false,
      error: expect.stringContaining("Invalid token amount"),
    });
  });

  it("rejects a zero amount before building or sending anything", async () => {
    const result = await transferSplTokenCore({ ...validInput, amount: "0" });

    expect(result).toEqual({
      success: false,
      error: expect.stringContaining("greater than zero"),
    });
    // A zero transfer must never create the recipient's token account.
    expect(mockAdapter.sendTransaction).not.toHaveBeenCalled();
  });
});
