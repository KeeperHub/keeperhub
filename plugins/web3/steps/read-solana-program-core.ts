/**
 * Core read-solana-program-anchor logic.
 *
 * IMPORTANT: This file must NOT contain "use step" or be a step file.
 */
import "server-only";
import { BN, BorshAccountsCoder } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { ErrorCategory, logUserError } from "@/lib/logging";
import { getErrorMessage } from "@/lib/utils";
import { parseAnchorIdl } from "@/lib/web3/anchor-idl";
import {
  fetchSolanaAccountInfo,
  parsePublicKey,
  resolveSolanaAccountAddress,
} from "@/lib/web3/solana-account-reader";
import {
  applyReadFailOnError,
  type ReadDestinationFailure,
  type ReadFailOnErrorInput,
} from "./read-fail-on-error-core";

export type ReadSolanaProgramCoreInput = ReadFailOnErrorInput & {
  network: string;
  accountAddress: string;
  programId: string;
  idl: string | object;
  accountType: string;
  _context?: { executionId?: string };
};

export type ReadSolanaProgramResult =
  | {
      success: true;
      // Null when failOnError=false softened a failed read into a success
      // value so the workflow continues; `error` carries the reason.
      result: unknown;
      owner: string | null;
      lamports: number | null;
      addressLink: string;
      error?: string;
    }
  | (ReadDestinationFailure & { success: false; error: string });

/** Data fields a softened read reports, so a soft failure never looks like a decoded account. */
const SOFT_ACCOUNT_FIELDS = {
  result: null,
  owner: null,
  lamports: null,
  addressLink: "",
} as const;

/**
 * Recursively converts Anchor's decoded value tree into JSON-safe values:
 * PublicKey -> base58, BN -> decimal string, byte arrays -> base64. Anchor's
 * decoder resolves defined/vec/option types into plain objects/arrays/nulls,
 * so a generic walk covers every IDL shape without needing the type layout.
 */
function serializeAnchorValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof PublicKey) {
    return value.toBase58();
  }
  if (value instanceof BN) {
    // bn.js ships no type declarations; TypeScript's JS-inference for it
    // (via allowJs) misses the toString(base) overload, so the base-10
    // argument is omitted here - toString() with no argument already
    // defaults to base 10.
    return value.toString();
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return Buffer.from(value).toString("base64");
  }
  if (Array.isArray(value)) {
    return value.map(serializeAnchorValue);
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = serializeAnchorValue(entry);
    }
    return out;
  }
  return value;
}

export async function readSolanaProgramCore(
  input: ReadSolanaProgramCoreInput
): Promise<ReadSolanaProgramResult> {
  return applyReadFailOnError(
    await readSolanaProgramInner(input),
    input.failOnError,
    SOFT_ACCOUNT_FIELDS
  );
}

async function readSolanaProgramInner(
  input: ReadSolanaProgramCoreInput
): Promise<ReadSolanaProgramResult> {
  const { network, accountAddress, programId, idl, accountType } = input;

  const resolved = resolveSolanaAccountAddress(network, accountAddress);
  if ("error" in resolved) {
    return { success: false, destinationError: true, error: resolved.error };
  }
  const { adapter, pubkey, chainId } = resolved;

  const programPk = parsePublicKey(programId);
  if (!programPk) {
    return {
      success: false,
      destinationError: true,
      error: `Invalid Solana program address: ${programId}`,
    };
  }

  const idlResult = parseAnchorIdl(idl);
  if ("error" in idlResult) {
    return { success: false, error: idlResult.error };
  }

  const trimmedAccountType = accountType?.trim() ?? "";
  if (trimmedAccountType === "") {
    return { success: false, error: "Missing account type" };
  }

  const idlAccounts = Array.isArray(idlResult.idl.accounts)
    ? idlResult.idl.accounts
    : [];
  const accountDef = idlAccounts.find(
    (entry) => entry.name === trimmedAccountType
  );
  if (!accountDef) {
    const available = idlAccounts.map((entry) => entry.name).join(", ") || "none";
    return {
      success: false,
      error: `Account type "${trimmedAccountType}" not found in IDL. Available: ${available}`,
    };
  }

  const fetched = await fetchSolanaAccountInfo(adapter, pubkey);
  if ("error" in fetched) {
    logUserError(
      ErrorCategory.NETWORK_RPC,
      "[Read Solana Program] Failed to read account",
      fetched.error,
      {
        plugin_name: "web3",
        action_name: "read-solana-program-anchor",
        chain_id: String(chainId),
      }
    );
    return { success: false, error: fetched.error };
  }
  if (!fetched.accountInfo) {
    const message = `Account not found: ${accountAddress}`;
    return { success: false, error: message };
  }

  const { owner, lamports, data } = fetched.accountInfo;
  if (!owner.equals(programPk)) {
    return {
      success: false,
      error: `Account ${accountAddress} is owned by ${owner.toBase58()}, not the expected program ${programPk.toBase58()}`,
    };
  }

  let result: unknown;
  try {
    const decoded = new BorshAccountsCoder(idlResult.idl).decode(
      trimmedAccountType,
      data
    );
    result = serializeAnchorValue(decoded);
  } catch (error) {
    return {
      success: false,
      error: `Failed to decode account as "${trimmedAccountType}": ${getErrorMessage(error)}`,
    };
  }

  const addressLink = await adapter.getAddressUrl(accountAddress);

  return {
    success: true,
    result,
    owner: owner.toBase58(),
    lamports,
    addressLink,
  };
}
