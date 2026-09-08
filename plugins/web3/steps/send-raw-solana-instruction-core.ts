import "server-only";

import {
  type AccountMeta,
  type PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import { ErrorCategory, logUserError } from "@/lib/logging";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { isSolanaChain } from "@/lib/rpc/provider-factory";
import { getErrorMessage } from "@/lib/utils";
import { getChainAdapter } from "@/lib/web3/chain-adapter";
import type { SolanaChainAdapter } from "@/lib/web3/chain-adapter/solana";
import { resolveOrganizationContext } from "@/lib/web3/resolve-org-context";
import { resolveWallet } from "@/lib/web3/resolve-solana-wallet";
import { isRecord, parsePublicKey } from "@/lib/web3/solana-account-reader";
import {
  buildSerializedSolanaInstructionTx,
  submitSolanaInstructionTx,
} from "@/lib/web3/solana-instruction-tx";
import { parseRequiredMaxSolLamports } from "@/lib/web3/solana-max-sol-guard";

// Guardrails. The 1232-byte cap is Solana's single-packet transaction size
// limit (IPv6 MTU minus headers); a larger transaction cannot be submitted, so
// rejecting it up front turns a network-layer failure into a clear message. The
// instruction cap is a defensive bound well above any single-transaction use.
const MAX_INSTRUCTIONS = 10;
const MAX_TX_SIZE_BYTES = 1232;

const HEX_BODY = /^[0-9a-fA-F]*$/;
const BASE64_BODY = /^[A-Za-z0-9+/]*={0,2}$/;
const TRAILING_PADDING = /=+$/;
const WHITESPACE = /\s+/g;

export type RawSolanaAccount = {
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
};

export type RawSolanaInstruction = {
  programId: string;
  accounts: RawSolanaAccount[];
  data: string;
};

export type SendRawSolanaInstructionCoreInput = {
  network: string;
  instructions: string | RawSolanaInstruction[];
  /**
   * Maximum SOL (human decimal) this transaction may move out of the
   * organization wallet. Charged against the daily value cap before the
   * transaction is built and enforced against the simulated balance delta
   * before submit. Required: an arbitrary instruction can invoke any program,
   * so the value moved is not derivable from the instruction data.
   */
  maxSol?: string;
  _context?: {
    executionId?: string;
    organizationId?: string;
    valueCapReserved?: boolean;
  };
};

export type SendRawSolanaInstructionResult =
  | {
      success: true;
      transactionHash: string;
      transactionLink: string;
      gasUsedUnits: string;
      effectiveGasPrice: string;
      instructionCount: number;
    }
  | { success: false; error: string };

/**
 * Decodes an instruction's data field. Mirrors normalizeSolanaTransaction: a
 * "0x" prefix means hex, otherwise base64. Empty data is valid (some
 * instructions carry no bytes).
 *
 * Buffer.from does not error on malformed input - it silently drops characters
 * that do not form complete groups, so a typo'd payload would decode to fewer
 * bytes than intended. Both branches guard against that: hex requires an even
 * length over the hex charset, and standard base64 is confirmed lossless by
 * re-encoding the decoded bytes and comparing (padding-insensitive, so padded
 * and unpadded inputs are both accepted). Internal whitespace is stripped from
 * the base64 candidate first, since long payloads are often pasted line-wrapped.
 */
function decodeInstructionData(value: string): Buffer | null {
  const trimmed = value.trim();

  if (trimmed.startsWith("0x")) {
    const body = trimmed.slice(2);
    if (body.length % 2 !== 0 || !HEX_BODY.test(body)) {
      return null;
    }
    return Buffer.from(body, "hex");
  }

  const base64 = trimmed.replace(WHITESPACE, "");
  if (!BASE64_BODY.test(base64)) {
    return null;
  }
  const decoded = Buffer.from(base64, "base64");
  const reencoded = decoded.toString("base64").replace(TRAILING_PADDING, "");
  if (reencoded !== base64.replace(TRAILING_PADDING, "")) {
    return null;
  }
  return decoded;
}

function parseInstructionsInput(
  input: string | RawSolanaInstruction[]
): { instructions: unknown[] } | { error: string } {
  let parsed: unknown = input;

  // The json-editor UI field emits its value as a JSON string, while direct/MCP
  // callers pass a native array. Mirrors sign-typed-data-core.ts.
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch (err) {
      return { error: `instructions is not valid JSON: ${getErrorMessage(err)}` };
    }
  }

  if (!Array.isArray(parsed)) {
    return { error: "instructions must be a JSON array" };
  }
  if (parsed.length === 0) {
    return { error: "At least one instruction is required" };
  }
  if (parsed.length > MAX_INSTRUCTIONS) {
    return {
      error: `Too many instructions: ${parsed.length} (max ${MAX_INSTRUCTIONS})`,
    };
  }

  return { instructions: parsed };
}

/**
 * Validates one account entry and builds its AccountMeta. Structural only - the
 * signer-identity check (a signer must be the org wallet) runs later in
 * findForeignSigner, once the wallet has been resolved, so purely malformed
 * input can be rejected without a wallet lookup.
 */
function buildAccountMeta(
  account: unknown,
  index: number
): { key: AccountMeta } | { error: string } {
  if (!isRecord(account)) {
    return { error: `Account at index ${index} must be an object` };
  }
  if (typeof account.pubkey !== "string") {
    return { error: `Account at index ${index} is missing a string pubkey` };
  }
  const pubkey = parsePublicKey(account.pubkey);
  if (!pubkey) {
    return { error: `Invalid account pubkey at index ${index}: ${account.pubkey}` };
  }
  if (typeof account.isSigner !== "boolean") {
    return { error: `Account at index ${index} is missing a boolean isSigner` };
  }
  if (typeof account.isWritable !== "boolean") {
    return { error: `Account at index ${index} is missing a boolean isWritable` };
  }

  return {
    key: { pubkey, isSigner: account.isSigner, isWritable: account.isWritable },
  };
}

function buildInstruction(
  raw: unknown,
  index: number
): { instruction: TransactionInstruction } | { error: string } {
  if (!isRecord(raw)) {
    return { error: `Instruction at index ${index} must be an object` };
  }

  if (typeof raw.programId !== "string") {
    return { error: `Instruction ${index} is missing a string programId` };
  }
  const programId = parsePublicKey(raw.programId);
  if (!programId) {
    return { error: `Invalid programId at instruction ${index}: ${raw.programId}` };
  }

  if (!Array.isArray(raw.accounts)) {
    return { error: `Instruction ${index} must have an accounts array` };
  }

  const keys: AccountMeta[] = [];
  for (const [accountIndex, account] of raw.accounts.entries()) {
    const meta = buildAccountMeta(account, accountIndex);
    if ("error" in meta) {
      return { error: `Instruction ${index}: ${meta.error}` };
    }
    keys.push(meta.key);
  }

  if (typeof raw.data !== "string") {
    return { error: `Instruction ${index} data must be a base64 or 0x-hex string` };
  }
  const data = decodeInstructionData(raw.data);
  if (!data) {
    return {
      error: `Instruction ${index} data is not valid standard base64 or 0x-hex`,
    };
  }

  return {
    instruction: new TransactionInstruction({ programId, keys, data }),
  };
}

function buildAllInstructions(
  instructions: unknown[]
): { built: TransactionInstruction[]; totalDataBytes: number } | { error: string } {
  const built: TransactionInstruction[] = [];
  let totalDataBytes = 0;
  for (const [index, raw] of instructions.entries()) {
    const result = buildInstruction(raw, index);
    if ("error" in result) {
      return { error: result.error };
    }
    built.push(result.instruction);
    totalDataBytes += result.instruction.data.length;
  }
  return { built, totalDataBytes };
}

/**
 * Returns the base58 of the first account marked isSigner that is not the org
 * wallet, or null when every signer is the wallet. The wallet is the only key
 * this action can sign with (and is always the fee payer / signer #0), so a
 * foreign signer would compile to a transaction that can never gather its
 * signatures. Rejecting up front turns that into an actionable error instead of
 * an opaque on-chain signature-verification failure.
 */
function findForeignSigner(
  instructions: TransactionInstruction[],
  walletPk: PublicKey
): string | null {
  for (const ix of instructions) {
    for (const key of ix.keys) {
      if (key.isSigner && !key.pubkey.equals(walletPk)) {
        return key.pubkey.toBase58();
      }
    }
  }
  return null;
}

export async function sendRawSolanaInstructionCore(
  input: SendRawSolanaInstructionCoreInput
): Promise<SendRawSolanaInstructionResult> {
  const { network, _context } = input;

  let chainId: number;
  try {
    chainId = getChainIdFromNetwork(network);
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }

  if (!isSolanaChain(chainId)) {
    return {
      success: false,
      error: `Send Raw Solana Instruction is only supported on Solana networks, got: ${network}`,
    };
  }

  const maxSolParsed = parseRequiredMaxSolLamports(input.maxSol);
  if ("error" in maxSolParsed) {
    return { success: false, error: maxSolParsed.error };
  }

  const parsed = parseInstructionsInput(input.instructions);
  if ("error" in parsed) {
    return { success: false, error: parsed.error };
  }

  // Structural validation and the size pre-check are pure and cheap, so they run
  // before the wallet lookup: malformed input fails without resolving the org
  // wallet. The signer-identity check needs the wallet, so it is deferred below.
  const built = buildAllInstructions(parsed.instructions);
  if ("error" in built) {
    return { success: false, error: built.error };
  }

  // Deterministic guardrail: the instruction data alone already overflows the
  // packet limit, so the transaction cannot be built regardless of account
  // count. Caught here so the message is clear rather than serialize()'s opaque
  // "offset out of range".
  if (built.totalDataBytes > MAX_TX_SIZE_BYTES) {
    return {
      success: false,
      error: `Transaction too large: instruction data totals ${built.totalDataBytes} bytes, over Solana's ${MAX_TX_SIZE_BYTES}-byte single-packet limit. Reduce the number or size of instructions.`,
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
    "[Send Raw Solana Instruction]",
    "send-raw-solana-instruction"
  );
  if (!orgCtx.success) {
    return orgCtx;
  }

  const wallet = await resolveWallet(orgCtx.organizationId);
  if ("error" in wallet) {
    return { success: false, error: wallet.error };
  }

  const walletPk = parsePublicKey(wallet.address);
  if (!walletPk) {
    return {
      success: false,
      error: `Organization wallet has an invalid Solana address: ${wallet.address}`,
    };
  }

  const foreignSigner = findForeignSigner(built.built, walletPk);
  if (foreignSigner) {
    return {
      success: false,
      error: `Account ${foreignSigner} is marked isSigner, but only the organization wallet (${walletPk.toBase58()}) can sign`,
    };
  }

  let data: string;
  try {
    data = buildSerializedSolanaInstructionTx({
      feePayer: walletPk,
      instructions: built.built,
    });
  } catch (error) {
    // Once accounts and headers are included, serialize() throws past the same
    // packet limit. Inputs are already validated (pubkeys parsed, data decoded),
    // so a throw here is a size overflow, not malformed data.
    return {
      success: false,
      error: `Transaction too large to serialize (Solana's single-packet limit is ${MAX_TX_SIZE_BYTES} bytes): ${getErrorMessage(error)}`,
    };
  }

  try {
    const submitted = await submitSolanaInstructionTx({
      adapter: getChainAdapter(chainId) as SolanaChainAdapter,
      solanaSigner: wallet.signer,
      feePayer: walletPk,
      data,
      maxSolLamports: maxSolParsed.lamports,
    });

    return {
      success: true,
      transactionHash: submitted.hash,
      transactionLink: submitted.transactionLink,
      gasUsedUnits: submitted.computeUnitsConsumed,
      effectiveGasPrice: submitted.effectiveGasPrice,
      instructionCount: built.built.length,
    };
  } catch (error) {
    logUserError(
      ErrorCategory.TRANSACTION,
      "[Send Raw Solana Instruction] Transaction failed",
      error,
      {
        plugin_name: "web3",
        action_name: "send-raw-solana-instruction",
        chain_id: String(chainId),
      }
    );
    return { success: false, error: getErrorMessage(error) };
  }
}
