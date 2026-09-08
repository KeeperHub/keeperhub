/**
 * Core read-solana-account logic.
 *
 * IMPORTANT: This file must NOT contain "use step" or be a step file.
 */
import "server-only";
import { ErrorCategory, logUserError } from "@/lib/logging";
import {
  fetchSolanaAccountInfo,
  resolveSolanaAccountAddress,
} from "@/lib/web3/solana-account-reader";
import {
  applyReadFailOnError,
  type ReadDestinationFailure,
  type ReadFailOnErrorInput,
} from "./read-fail-on-error-core";

export type ReadSolanaAccountCoreInput = ReadFailOnErrorInput & {
  network: string;
  accountAddress: string;
  _context?: { executionId?: string };
};

export type ReadSolanaAccountResult =
  // `exists: null` is the softened failure failOnError=false produces: the
  // read did not complete, so whether the account exists is unknown. It is
  // deliberately not `exists: false`, which a downstream node would read as
  // the account being absent.
  | { success: true; exists: null; error: string }
  | { success: true; exists: false }
  | {
      success: true;
      exists: true;
      owner: string;
      lamports: number;
      executable: boolean;
      rentEpoch: number | null;
      dataBase64: string;
      dataLength: number;
      addressLink: string;
    }
  | (ReadDestinationFailure & { success: false; error: string });

export async function readSolanaAccountCore(
  input: ReadSolanaAccountCoreInput
): Promise<ReadSolanaAccountResult> {
  return applyReadFailOnError(
    await readSolanaAccountInner(input),
    input.failOnError,
    { exists: null }
  );
}

async function readSolanaAccountInner(
  input: ReadSolanaAccountCoreInput
): Promise<ReadSolanaAccountResult> {
  const { network, accountAddress } = input;

  const resolved = resolveSolanaAccountAddress(network, accountAddress);
  if ("error" in resolved) {
    return { success: false, destinationError: true, error: resolved.error };
  }
  const { adapter, pubkey, chainId } = resolved;

  const [fetched, addressLink] = await Promise.all([
    fetchSolanaAccountInfo(adapter, pubkey),
    adapter.getAddressUrl(accountAddress),
  ]);

  if ("error" in fetched) {
    logUserError(
      ErrorCategory.NETWORK_RPC,
      "[Read Solana Account] Failed to read account",
      fetched.error,
      {
        plugin_name: "web3",
        action_name: "read-solana-account",
        chain_id: String(chainId),
      }
    );
    return { success: false, error: fetched.error };
  }

  if (!fetched.accountInfo) {
    return { success: true, exists: false };
  }

  const { executable, owner, lamports, data, rentEpoch } =
    fetched.accountInfo;

  return {
    success: true,
    exists: true,
    owner: owner.toBase58(),
    lamports,
    executable,
    rentEpoch: rentEpoch ?? null,
    dataBase64: data.toString("base64"),
    dataLength: data.length,
    addressLink,
  };
}
