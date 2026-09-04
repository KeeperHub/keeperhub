import "server-only";

import {
  ACCOUNT_SIZE,
  AccountState,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  ExtensionType,
  getAccountLen,
  getAccountLenForMint,
  getAssociatedTokenAddressSync,
  getDefaultAccountState,
  getExtensionTypes,
  type Mint,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  unpackAccount,
  unpackMint,
} from "@solana/spl-token";
import type { AccountInfo } from "@solana/web3.js";
import { PublicKey, Transaction } from "@solana/web3.js";
import { ethers } from "ethers";
import { ErrorCategory, logUserError } from "@/lib/logging";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { isSolanaChain } from "@/lib/rpc/provider-factory";
import { getErrorMessage } from "@/lib/utils";
import { getChainAdapter } from "@/lib/web3/chain-adapter";
import type { SolanaChainAdapter } from "@/lib/web3/chain-adapter/solana";
import type { SolanaTransactionSigner } from "@/lib/web3/chain-adapter/types";
import type { NonceSession } from "@/lib/web3/nonce-manager";
import { resolveOrganizationContext } from "@/lib/web3/resolve-org-context";
import { resolveWallet } from "@/lib/web3/resolve-solana-wallet";
import { parsePublicKey } from "@/lib/web3/solana-account-reader";
import {
  computeSolanaLamportFee,
  SOLANA_BASE_FEE_LAMPORTS,
  SOLANA_SPL_MAX_FEE_LAMPORTS,
} from "@/lib/web3/solana-fees";

/**
 * Serializing a legacy Transaction requires a recentBlockhash and a feePayer or
 * serialize() throws. SolanaChainAdapter.sendTransaction overwrites the
 * blockhash with a freshly fetched one before signing, so this placeholder never
 * reaches the signer or the chain. PublicKey.default is 32 zero bytes, which is
 * valid base58 and satisfies the serializer.
 */
const PLACEHOLDER_BLOCKHASH = PublicKey.default.toBase58();

/**
 * Mint extensions we decline to transfer. TransferHook and NonTransferable make
 * a plain transferChecked fail outright. TransferFeeConfig does not - the mint
 * transfers fine, but the program withholds a fee so the recipient receives less
 * than the requested amount; without reading and reporting the net figure the
 * step would overstate what was transferred, so v1 rejects these rather than
 * report a wrong amount. Rejecting up front turns each case into an actionable
 * error instead of an opaque simulation failure or a silent accounting gap.
 */
const UNSUPPORTED_EXTENSIONS = new Map<ExtensionType, string>([
  [
    ExtensionType.TransferHook,
    "the mint has a transfer hook, which requires resolving extra accounts",
  ],
  [ExtensionType.NonTransferable, "the mint is non-transferable"],
  [
    ExtensionType.TransferFeeConfig,
    "the mint charges a transfer fee, so the recipient would receive less than the requested amount",
  ],
]);

export type TransferSplTokenCoreInput = {
  network: string;
  mint: string;
  recipientAddress: string;
  amount: string;
  _context?: { executionId?: string; organizationId?: string };
};

export type TransferSplTokenResult =
  | {
      success: true;
      transactionHash: string;
      transactionLink: string;
      gasUsed: string;
      gasUsedUnits: string;
      effectiveGasPrice: string;
      amount: string;
      recipient: string;
      mint: string;
      decimals: number;
      recipientTokenAccount: string;
      createdRecipientAccount: boolean;
    }
  | { success: false; error: string };

type SolanaAccount = AccountInfo<Buffer> | null;

type TransferContext = {
  adapter: SolanaChainAdapter;
  chainId: number;
  ownerPk: PublicKey;
  recipientPk: PublicKey;
  mintPk: PublicKey;
  amount: string;
  solanaSigner: SolanaTransactionSigner;
};

/**
 * Exported for dispatch-routing tests, mirroring isSolanaTransferPath in
 * transfer-funds-core.ts.
 */
export function isSplTransferPath(chainId: number): boolean {
  return isSolanaChain(chainId);
}

function isTokenProgram(programId: PublicKey): boolean {
  return (
    programId.equals(TOKEN_PROGRAM_ID) || programId.equals(TOKEN_2022_PROGRAM_ID)
  );
}

/**
 * Returns the reason a mint cannot be transferred, or null when it can.
 */
function findUnsupportedExtension(mint: Mint): string | null {
  const extensions = getExtensionTypes(mint.tlvData);

  for (const extension of extensions) {
    const reason = UNSUPPORTED_EXTENSIONS.get(extension);
    if (reason) {
      return reason;
    }
  }

  if (extensions.includes(ExtensionType.DefaultAccountState)) {
    if (getDefaultAccountState(mint)?.state === AccountState.Frozen) {
      return "the mint freezes new token accounts by default";
    }
  }

  return null;
}

function parseAmount(
  amount: string,
  decimals: number
): { raw: bigint } | { error: string } {
  try {
    const raw = ethers.parseUnits(amount.trim(), decimals);
    // Reject zero as well as negatives: a zero transfer moves nothing but, when
    // the recipient has no token account, still spends the sender's SOL creating
    // an empty one - a silent cost for a no-op reported as success.
    if (raw <= BigInt(0)) {
      return { error: `Token amount must be greater than zero: ${amount}` };
    }
    return { raw };
  } catch {
    return { error: `Invalid token amount: ${amount}` };
  }
}

/**
 * Builds the transfer as a prebuilt serialized transaction. SolanaChainAdapter
 * rejects executeContractCall (Solana has no ABI-encoded calls), so serialized
 * bytes in request.data are the only way onto its Turnkey signing and
 * submit/failover path.
 */
function buildSerializedTransfer(args: {
  ownerPk: PublicKey;
  recipientPk: PublicKey;
  mintPk: PublicKey;
  senderAta: PublicKey;
  recipientAta: PublicKey;
  programId: PublicKey;
  amountRaw: bigint;
  decimals: number;
  needsRecipientAta: boolean;
}): string {
  const transaction = new Transaction();

  if (args.needsRecipientAta) {
    // Idempotent: if the account appears between our read and inclusion, this
    // no-ops instead of failing the whole transfer.
    transaction.add(
      createAssociatedTokenAccountIdempotentInstruction(
        args.ownerPk,
        args.recipientAta,
        args.recipientPk,
        args.mintPk,
        args.programId,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
  }

  // transferChecked over transfer: it re-validates decimals on-chain, so a bad
  // decimals read fails loudly instead of moving a wrong amount, and Token-2022
  // rejects plain transfer for transfer-fee mints.
  transaction.add(
    createTransferCheckedInstruction(
      args.senderAta,
      args.mintPk,
      args.recipientAta,
      args.ownerPk,
      args.amountRaw,
      args.decimals,
      [],
      args.programId
    )
  );

  transaction.feePayer = args.ownerPk;
  transaction.recentBlockhash = PLACEHOLDER_BLOCKHASH;

  return transaction
    .serialize({ requireAllSignatures: false, verifySignatures: false })
    .toString("base64");
}

/**
 * Reads the mint account. Its owner is the source of truth for legacy SPL vs
 * Token-2022; unpackMint validates that owner and parses Token-2022 TLV data.
 */
async function resolveMint(
  adapter: SolanaChainAdapter,
  mintPk: PublicKey
): Promise<{ mint: Mint; programId: PublicKey } | { error: string }> {
  let mintInfo: SolanaAccount;
  try {
    mintInfo = await adapter.executeWithSolanaFailover(
      (connection) => connection.getAccountInfo(mintPk, "confirmed"),
      "read"
    );
  } catch (error) {
    return { error: `Failed to read mint account: ${getErrorMessage(error)}` };
  }

  if (!mintInfo) {
    return { error: `Mint account not found: ${mintPk.toBase58()}` };
  }

  const programId = mintInfo.owner;
  if (!isTokenProgram(programId)) {
    return {
      error: `${mintPk.toBase58()} is not an SPL token mint (owned by ${programId.toBase58()})`,
    };
  }

  // unpackMint throws on an account that is owned by a token program but is not
  // a well-formed mint - e.g. a token account address pasted into the mint field.
  try {
    return { mint: unpackMint(mintPk, mintInfo, programId), programId };
  } catch (error) {
    return {
      error: `${mintPk.toBase58()} is not a valid SPL mint: ${getErrorMessage(error)}`,
    };
  }
}

async function runPreflight(args: {
  adapter: SolanaChainAdapter;
  ownerPk: PublicKey;
  senderAta: PublicKey;
  recipientAta: PublicKey;
  recipientPk: PublicKey;
  programId: PublicKey;
  mintAccount: Mint;
  amountRaw: bigint;
}): Promise<{ needsRecipientAta: boolean } | { error: string }> {
  const { adapter, senderAta, recipientAta, programId, mintAccount, amountRaw } =
    args;

  let accounts: SolanaAccount[];
  try {
    // The owner's account is read in the same batch so its lamports feed the SOL
    // preflight without a separate getBalance round-trip.
    accounts = await adapter.executeWithSolanaFailover(
      (connection) =>
        connection.getMultipleAccountsInfo(
          [senderAta, recipientAta, args.recipientPk, args.ownerPk],
          "confirmed"
        ),
      "read"
    );
  } catch (error) {
    return { error: `Failed to read token accounts: ${getErrorMessage(error)}` };
  }

  const [senderInfo, recipientAtaInfo, recipientInfo, ownerInfo] = accounts;

  // A recipient address that is itself a token account means the caller pasted
  // a token account instead of a wallet; the ATA derived from it would be
  // unrecoverable.
  if (recipientInfo && isTokenProgram(recipientInfo.owner)) {
    return { error: "Recipient must be a wallet address, not a token account" };
  }

  if (!senderInfo) {
    return {
      error: `Wallet has no token account for mint ${mintAccount.address.toBase58()}`,
    };
  }

  let senderAccount: ReturnType<typeof unpackAccount>;
  try {
    senderAccount = unpackAccount(senderAta, senderInfo, programId);
  } catch (error) {
    return {
      error: `Failed to read the wallet's token account: ${getErrorMessage(error)}`,
    };
  }
  if (senderAccount.amount < amountRaw) {
    return {
      error: `Insufficient token balance. Have: ${senderAccount.amount.toString()}, Need: ${amountRaw.toString()} (raw units)`,
    };
  }

  const needsRecipientAta = !recipientAtaInfo;

  const rent = await resolveRentLamports(
    adapter,
    mintAccount,
    programId,
    needsRecipientAta
  );
  if ("error" in rent) {
    return rent;
  }

  // The daily Solana cap was charged a fixed worst case before this step ran,
  // because the reservation happens without a chain read. The true rent is only
  // knowable here, from the mint's own account layout, and a Token-2022 mint
  // carrying enough extensions can need more than that fixed figure. Refuse
  // rather than spend past what the ledger recorded.
  const ceilingCheck = checkReservedSolCeiling(rent.lamports);
  if (ceilingCheck) {
    return { error: ceilingCheck };
  }

  const solCheck = checkSolBalance({
    balanceLamports: BigInt(ownerInfo?.lamports ?? 0),
    rentLamports: rent.lamports,
    needsRecipientAta,
  });
  if (solCheck) {
    return { error: solCheck };
  }

  return { needsRecipientAta };
}

/**
 * The on-chain length of the associated token account the ATA program will
 * create. getAccountLenForMint covers only the account extensions the mint
 * implies; on Token-2022 the ATA program also always adds ImmutableOwner, which
 * that helper omits. Add it so the rent estimate is not short: as the first
 * account extension it introduces the account-type byte too, otherwise it is one
 * more zero-value TLV (4 bytes).
 */
function ataAccountLen(mintAccount: Mint, programId: PublicKey): number {
  const baseLen = getAccountLenForMint(mintAccount);
  if (!programId.equals(TOKEN_2022_PROGRAM_ID)) {
    return baseLen;
  }
  return baseLen === ACCOUNT_SIZE
    ? getAccountLen([ExtensionType.ImmutableOwner])
    : baseLen + 4;
}

async function resolveRentLamports(
  adapter: SolanaChainAdapter,
  mintAccount: Mint,
  programId: PublicKey,
  needsRecipientAta: boolean
): Promise<{ lamports: bigint } | { error: string }> {
  if (!needsRecipientAta) {
    return { lamports: BigInt(0) };
  }

  try {
    const lamports = await adapter.executeWithSolanaFailover(
      (connection) =>
        connection.getMinimumBalanceForRentExemption(
          ataAccountLen(mintAccount, programId)
        ),
      "read"
    );
    return { lamports: BigInt(lamports) };
  } catch (error) {
    return { error: `Failed to read rent exemption: ${getErrorMessage(error)}` };
  }
}

/**
 * Returns an error message when the real SOL cost of the transfer exceeds what
 * was reserved against the organization's daily Solana cap, or null when it
 * fits. Keeps the reservation an enforced ceiling rather than an estimate the
 * transfer is free to exceed.
 */
function checkReservedSolCeiling(rentLamports: bigint): string | null {
  const required = SOLANA_BASE_FEE_LAMPORTS + rentLamports;
  if (required <= SOLANA_SPL_MAX_FEE_LAMPORTS) {
    return null;
  }
  return `This token's account requires ${required.toString()} lamports (fee plus rent), above the ${SOLANA_SPL_MAX_FEE_LAMPORTS.toString()} lamports reserved against the organization's daily Solana spending cap`;
}

/** Returns an error message, or null when the balance covers fee plus rent. */
function checkSolBalance(args: {
  balanceLamports: bigint;
  rentLamports: bigint;
  needsRecipientAta: boolean;
}): string | null {
  const required = SOLANA_BASE_FEE_LAMPORTS + args.rentLamports;
  if (args.balanceLamports >= required) {
    return null;
  }
  const breakdown = args.needsRecipientAta
    ? `${SOLANA_BASE_FEE_LAMPORTS.toString()} fee + ${args.rentLamports.toString()} rent for the recipient's new token account`
    : `${SOLANA_BASE_FEE_LAMPORTS.toString()} fee`;
  return `Insufficient SOL balance. Have: ${args.balanceLamports.toString()} lamports, Need: ${required.toString()} lamports (${breakdown})`;
}

async function executeTransfer(
  ctx: TransferContext
): Promise<TransferSplTokenResult> {
  const { adapter, chainId, ownerPk, recipientPk, mintPk, amount } = ctx;

  const resolved = await resolveMint(adapter, mintPk);
  if ("error" in resolved) {
    return { success: false, error: resolved.error };
  }
  const { mint: mintAccount, programId } = resolved;

  const unsupported = findUnsupportedExtension(mintAccount);
  if (unsupported) {
    return {
      success: false,
      error: `Cannot transfer ${mintPk.toBase58()}: ${unsupported}`,
    };
  }

  const parsed = parseAmount(amount, mintAccount.decimals);
  if ("error" in parsed) {
    return { success: false, error: parsed.error };
  }

  const senderAta = getAssociatedTokenAddressSync(
    mintPk,
    ownerPk,
    false,
    programId,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  // Recipients may legitimately be program-owned (PDA) accounts, so off-curve
  // owners are allowed here.
  const recipientAta = getAssociatedTokenAddressSync(
    mintPk,
    recipientPk,
    true,
    programId,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const preflight = await runPreflight({
    adapter,
    ownerPk,
    senderAta,
    recipientAta,
    recipientPk,
    programId,
    mintAccount,
    amountRaw: parsed.raw,
  });
  if ("error" in preflight) {
    return { success: false, error: preflight.error };
  }

  const data = buildSerializedTransfer({
    ownerPk,
    recipientPk,
    mintPk,
    senderAta,
    recipientAta,
    programId,
    amountRaw: parsed.raw,
    decimals: mintAccount.decimals,
    needsRecipientAta: preflight.needsRecipientAta,
  });

  try {
    // gasOverrides is deliberately empty. With an override set,
    // normalizeSolanaTransaction takes its decompile/compileToV0Message branch
    // and silently rewrites this legacy transaction as v0 - a path Turnkey's
    // Solana signer has never been exercised against. Left empty, it only
    // normalizes the fee payer, which already equals the signer, so the
    // serialized bytes pass through untouched. A compute budget, if ever
    // needed, belongs in the instructions built above.
    const receipt = await adapter.sendTransaction(
      undefined as unknown as ethers.Signer, // unused by SolanaChainAdapter
      { to: recipientPk.toBase58(), data },
      undefined as unknown as NonceSession, // unused by SolanaChainAdapter
      { solanaSigner: ctx.solanaSigner, gasOverrides: {} }
    );

    const transactionLink = await adapter.getTransactionUrl(receipt.hash);

    // Prefer the fee the chain reported; the compute-budget reconstruction is
    // only a fallback for a receipt that carries no fee.
    const lamportFee =
      receipt.feeLamports ??
      computeSolanaLamportFee(receipt.gasUsed, receipt.effectiveGasPrice);

    return {
      success: true,
      transactionHash: receipt.hash,
      transactionLink,
      gasUsed: lamportFee.toString(),
      gasUsedUnits: receipt.gasUsed.toString(),
      effectiveGasPrice: receipt.effectiveGasPrice.toString(),
      amount,
      recipient: recipientPk.toBase58(),
      mint: mintPk.toBase58(),
      decimals: mintAccount.decimals,
      recipientTokenAccount: recipientAta.toBase58(),
      createdRecipientAccount: preflight.needsRecipientAta,
    };
  } catch (error) {
    logUserError(
      ErrorCategory.TRANSACTION,
      "[Transfer SPL Token] Transaction failed",
      error,
      {
        plugin_name: "web3",
        action_name: "transfer-spl-token",
        chain_id: String(chainId),
      }
    );
    return { success: false, error: getErrorMessage(error) };
  }
}

export async function transferSplTokenCore(
  input: TransferSplTokenCoreInput
): Promise<TransferSplTokenResult> {
  const { network, mint, recipientAddress, amount, _context } = input;

  let chainId: number;
  try {
    chainId = getChainIdFromNetwork(network);
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }

  if (!isSplTransferPath(chainId)) {
    return {
      success: false,
      error: `Transfer SPL Token is only supported on Solana networks, got: ${network}`,
    };
  }

  if (!amount || amount.trim() === "") {
    return { success: false, error: "Amount is required" };
  }

  const mintPk = parsePublicKey(mint);
  if (!mintPk) {
    return { success: false, error: `Invalid Solana mint address: ${mint}` };
  }

  const recipientPk = parsePublicKey(recipientAddress);
  if (!recipientPk) {
    return {
      success: false,
      error: `Invalid Solana recipient address: ${recipientAddress}`,
    };
  }

  if (!(_context?.executionId || _context?.organizationId)) {
    return {
      success: false,
      error: "Execution ID or organization ID is required",
    };
  }

  const orgCtx = await resolveOrganizationContext(
    _context,
    "[Transfer SPL Token]",
    "transfer-spl-token"
  );
  if (!orgCtx.success) {
    return orgCtx;
  }

  const wallet = await resolveWallet(orgCtx.organizationId, chainId);
  if ("error" in wallet) {
    return { success: false, error: wallet.error };
  }

  const ownerPk = parsePublicKey(wallet.address);
  if (!ownerPk) {
    return {
      success: false,
      error: `Organization wallet has an invalid Solana address: ${wallet.address}`,
    };
  }

  return await executeTransfer({
    adapter: getChainAdapter(chainId) as SolanaChainAdapter,
    chainId,
    ownerPk,
    recipientPk,
    mintPk,
    amount,
    solanaSigner: wallet.signer,
  });
}
