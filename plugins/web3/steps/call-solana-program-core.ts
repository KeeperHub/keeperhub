import "server-only";

import { ErrorCategory, logUserError } from "@/lib/logging";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { isSolanaChain } from "@/lib/rpc/provider-factory";
import { getErrorMessage } from "@/lib/utils";
import {
  encodeAnchorInstruction,
  parseAnchorIdl,
} from "@/lib/web3/anchor-idl";
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

const MAX_TX_SIZE_BYTES = 1232;

export type CallSolanaProgramCoreInput = {
  network: string;
  programId: string;
  idl: string | object;
  instruction: string;
  args?: string | Record<string, unknown>;
  accounts?: string | Record<string, unknown>;
  /**
   * Maximum SOL (human decimal) this instruction may move out of the
   * organization wallet. Charged against the daily value cap before the
   * transaction is built and enforced against the simulated balance delta
   * before submit. Required: an Anchor instruction can move lamports through a
   * CPI that never appears in its encoded arguments.
   */
  maxSol?: string;
  _context?: {
    executionId?: string;
    organizationId?: string;
    valueCapReserved?: boolean;
  };
};

export type CallSolanaProgramResult =
  | {
      success: true;
      transactionHash: string;
      transactionLink: string;
      gasUsedUnits: string;
      effectiveGasPrice: string;
      instruction: string;
    }
  | { success: false; error: string };

/**
 * Parses the args/accounts fields. The json-editor UI field emits a JSON
 * string, while direct/MCP callers pass a native object; an empty/absent value
 * is an empty object (an instruction may take no args or no user-supplied
 * accounts).
 */
function parseJsonObject(
  input: string | Record<string, unknown> | undefined,
  label: string
): { value: Record<string, unknown> } | { error: string } {
  if (input === undefined || input === "") {
    return { value: {} };
  }

  let parsed: unknown = input;
  if (typeof input === "string") {
    try {
      parsed = JSON.parse(input);
    } catch (error) {
      return { error: `${label} is not valid JSON: ${getErrorMessage(error)}` };
    }
  }

  if (!isRecord(parsed)) {
    return { error: `${label} must be a JSON object` };
  }
  return { value: parsed };
}

export async function callSolanaProgramCore(
  input: CallSolanaProgramCoreInput
): Promise<CallSolanaProgramResult> {
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
      error: `Call Solana Program is only supported on Solana networks, got: ${network}`,
    };
  }

  const maxSolParsed = parseRequiredMaxSolLamports(input.maxSol);
  if ("error" in maxSolParsed) {
    return { success: false, error: maxSolParsed.error };
  }

  const programId = parsePublicKey(input.programId);
  if (!programId) {
    return {
      success: false,
      error: `Invalid Solana program address: ${input.programId}`,
    };
  }

  if (!input.instruction || input.instruction.trim() === "") {
    return { success: false, error: "Instruction name is required" };
  }

  const idlResult = parseAnchorIdl(input.idl);
  if ("error" in idlResult) {
    return { success: false, error: idlResult.error };
  }

  const argsResult = parseJsonObject(input.args, "args");
  if ("error" in argsResult) {
    return { success: false, error: argsResult.error };
  }
  const accountsResult = parseJsonObject(input.accounts, "accounts");
  if ("error" in accountsResult) {
    return { success: false, error: accountsResult.error };
  }

  if (!(_context?.executionId || _context?.organizationId)) {
    return {
      success: false,
      error: "Execution ID or organization ID is required",
    };
  }

  const orgCtx = await resolveOrganizationContext(
    _context,
    "[Call Solana Program]",
    "call-solana-program-anchor"
  );
  if (!orgCtx.success) {
    return orgCtx;
  }

  const wallet = await resolveWallet(orgCtx.organizationId, chainId);
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

  const encoded = encodeAnchorInstruction({
    idl: idlResult.idl,
    instructionName: input.instruction,
    args: argsResult.value,
    accountPubkeys: accountsResult.value,
    programId,
    walletPk,
  });
  if ("error" in encoded) {
    return { success: false, error: encoded.error };
  }

  let data: string;
  try {
    data = buildSerializedSolanaInstructionTx({
      feePayer: walletPk,
      instructions: [encoded.instruction],
    });
  } catch (error) {
    return {
      success: false,
      error: `Transaction too large to serialize (Solana's single-packet limit is ${MAX_TX_SIZE_BYTES} bytes): ${getErrorMessage(error)}`,
    };
  }

  const sizeBytes = Buffer.from(data, "base64").length;
  if (sizeBytes > MAX_TX_SIZE_BYTES) {
    return {
      success: false,
      error: `Transaction too large: ${sizeBytes} bytes (max ${MAX_TX_SIZE_BYTES})`,
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
      instruction: input.instruction,
    };
  } catch (error) {
    logUserError(
      ErrorCategory.TRANSACTION,
      "[Call Solana Program] Transaction failed",
      error,
      {
        plugin_name: "web3",
        action_name: "call-solana-program-anchor",
        chain_id: String(chainId),
      }
    );
    return { success: false, error: getErrorMessage(error) };
  }
}
