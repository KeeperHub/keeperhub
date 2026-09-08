import "server-only";
import { getRpcPreferenceUserId } from "@/lib/workflow/executor/helpers";

import { eq } from "drizzle-orm";
import { ethers } from "ethers";
import { db } from "@/lib/db";
import { explorerConfigs } from "@/lib/db/schema";
import {
  fetchContractTransactions,
  getAddressUrl,
  getTransactionUrl,
  type NormalizedTransaction,
  resolveExplorerUrlConfig,
} from "@/lib/explorer";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { getRpcProvider } from "@/lib/rpc/provider-factory";
import type { RpcProviderManager } from "@/lib/rpc/providers";
import { serializeArg } from "@/lib/web3/serialize-arg";
import { evmOnlyGuard } from "@/lib/web3/validate-chain-address";
import { getErrorMessage } from "@/lib/utils";
import { resolveBlockRange } from "./block-range-helpers";
import {
  applyReadFailOnError,
  type ReadDestinationFailure,
  type ReadFailOnErrorInput,
} from "./read-fail-on-error-core";

const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY;

type AbiEntry = { type: string; name: string };

export type DecodedTransaction = {
  hash: string;
  from: string;
  to: string;
  value: string;
  blockNumber: number;
  timestamp: string;
  functionName: string;
  functionSignature: string;
  args: Record<string, string>;
  transactionLink: string;
};

export type QueryTransactionsResult =
  | {
      success: true;
      // Null when failOnError=false softened a failed query into a success
      // value so the workflow continues; `error` carries the reason. Null
      // rather than an empty list so a downstream node cannot read a failed
      // query as "no matching transactions".
      transactions: DecodedTransaction[] | null;
      fromBlock: number | null;
      toBlock: number | null;
      totalFetched: number | null;
      matchCount: number | null;
      contractAddressLink: string;
      error?: string;
    }
  | (ReadDestinationFailure & { success: false; error: string });

export type QueryTransactionsCoreInput = ReadFailOnErrorInput & {
  network: string;
  contractAddress: string;
  abi: string;
  abiFunction: string;
  functionArgs?: string | unknown[];
  fromBlock?: string;
  toBlock?: string;
  blockCount?: number | string;
  _context?: { executionId?: string; organizationId?: string };
};

function parseAbi(
  abi: string
): { success: true; parsed: AbiEntry[] } | { success: false; error: string } {
  let parsedAbi: unknown;
  try {
    parsedAbi = JSON.parse(abi);
  } catch (error) {
    return {
      success: false,
      error: `Invalid ABI JSON: ${getErrorMessage(error)}`,
    };
  }

  if (!Array.isArray(parsedAbi)) {
    return { success: false, error: "ABI must be a JSON array" };
  }

  const hasValidEntries = parsedAbi.every(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      typeof entry.type === "string"
  );
  if (!hasValidEntries) {
    return {
      success: false,
      error: "Invalid ABI: each entry must be an object with a 'type' field",
    };
  }

  return { success: true, parsed: parsedAbi as AbiEntry[] };
}

const serializeValue = serializeArg;

type TxLinkBuilder = { getTransactionUrl: (hash: string) => string };

function decodeTransaction(
  tx: NormalizedTransaction,
  iface: ethers.Interface,
  linkBuilder: TxLinkBuilder
): DecodedTransaction | null {
  try {
    const parsed = iface.parseTransaction({ data: tx.input, value: tx.value });
    if (!parsed) {
      return null;
    }

    const args: Record<string, string> = {};
    for (const [index, input] of parsed.fragment.inputs.entries()) {
      const name = input.name || `arg${index}`;
      args[name] = serializeValue(parsed.args[index]);
    }

    return {
      hash: tx.hash,
      from: tx.from,
      to: tx.to,
      value: tx.value,
      blockNumber: tx.blockNumber,
      timestamp: tx.timestamp,
      functionName: parsed.name,
      functionSignature: parsed.signature,
      args,
      transactionLink: linkBuilder.getTransactionUrl(tx.hash),
    };
  } catch {
    return null;
  }
}

function matchesArgFilter(
  decoded: DecodedTransaction,
  filterArgs: string[],
  functionInputs: readonly ethers.ParamType[]
): boolean {
  for (const [index, filterValue] of filterArgs.entries()) {
    if (filterValue === "") {
      continue;
    }

    const paramName = functionInputs[index]?.name || `arg${index}`;
    const decodedValue = decoded.args[paramName] ?? "";

    // Case-insensitive comparison for addresses
    if (filterValue.toLowerCase() !== decodedValue.toLowerCase()) {
      return false;
    }
  }

  return true;
}

function toStringArray(arr: unknown[]): string[] {
  const result: string[] = [];
  for (const v of arr) {
    result.push(typeof v === "string" ? v : String(v ?? ""));
  }
  return result;
}

function parseFunctionArgsFilter(
  functionArgs: string | unknown[] | undefined
): string[] | null {
  if (functionArgs === undefined || functionArgs === null) {
    return null;
  }

  // Already an array (workflow engine may pass parsed values)
  if (Array.isArray(functionArgs)) {
    const result = toStringArray(functionArgs);
    return result.every((v) => v === "") ? null : result;
  }

  // Empty string means no filter
  if (typeof functionArgs === "string" && functionArgs.trim() === "") {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(functionArgs);
    if (Array.isArray(parsed)) {
      const result = toStringArray(parsed);
      return result.every((v) => v === "") ? null : result;
    }
  } catch {
    // Invalid JSON - skip argument filtering
  }

  return null;
}

function filterAndDecodeTransactions(
  transactions: NormalizedTransaction[],
  contractAddress: string,
  iface: ethers.Interface,
  functionFragment: ethers.FunctionFragment,
  filterArgs: string[] | null,
  getTxLink: (hash: string) => string
): { matched: DecodedTransaction[]; totalFiltered: number } {
  const lowerContractAddress = contractAddress.toLowerCase();
  const linkBuilder: TxLinkBuilder = { getTransactionUrl: getTxLink };
  const matched: DecodedTransaction[] = [];
  let toContractCount = 0;

  for (const tx of transactions) {
    if (tx.to.toLowerCase() !== lowerContractAddress) {
      continue;
    }
    toContractCount++;

    const decoded = decodeTransaction(tx, iface, linkBuilder);
    if (!decoded) {
      continue;
    }

    if (decoded.functionName !== functionFragment.name) {
      continue;
    }

    if (
      filterArgs !== null &&
      !matchesArgFilter(decoded, filterArgs, functionFragment.inputs)
    ) {
      continue;
    }

    matched.push(decoded);
  }

  return { matched, totalFiltered: toContractCount };
}

type ValidatedInput = {
  iface: ethers.Interface;
  functionFragment: ethers.FunctionFragment;
  chainId: number;
};

function validateInputs(
  input: QueryTransactionsCoreInput
):
  | { success: true; data: ValidatedInput }
  | (ReadDestinationFailure & { success: false; error: string }) {
  const { contractAddress, abi, abiFunction } = input;

  // Resolve the chain first so the address check and the Solana guard below
  // can branch on the chain family.
  let chainId: number;
  try {
    chainId = getChainIdFromNetwork(input.network);
  } catch (error) {
    return {
      success: false,
      destinationError: true,
      error: getErrorMessage(error),
    };
  }

  // Transaction querying decodes calls via an EVM ABI function selector,
  // which has no Solana equivalent - not yet supported.
  const evmOnlyResult = evmOnlyGuard(chainId);
  if (evmOnlyResult) {
    return evmOnlyResult;
  }

  if (!ethers.isAddress(contractAddress)) {
    return {
      success: false,
      destinationError: true,
      error: `Invalid contract address: ${contractAddress}`,
    };
  }

  const abiResult = parseAbi(abi);
  if (!abiResult.success) {
    return { success: false, error: abiResult.error };
  }

  const iface = new ethers.Interface(abiResult.parsed);
  const functionFragment = iface.getFunction(abiFunction);
  if (!functionFragment) {
    return {
      success: false,
      error: `Function '${abiFunction}' not found in ABI`,
    };
  }

  return {
    success: true,
    data: { iface, functionFragment, chainId },
  };
}

/** Data fields a softened query reports, so a soft failure never looks like an empty result set. */
const SOFT_QUERY_FIELDS = {
  transactions: null,
  fromBlock: null,
  toBlock: null,
  totalFetched: null,
  matchCount: null,
} as const;

export async function queryTransactionsCore(
  input: QueryTransactionsCoreInput
): Promise<QueryTransactionsResult> {
  return applyReadFailOnError(
    await queryTransactionsInner(input),
    input.failOnError,
    { ...SOFT_QUERY_FIELDS, contractAddressLink: "" }
  );
}

async function queryTransactionsInner(
  input: QueryTransactionsCoreInput
): Promise<QueryTransactionsResult> {
  const validation = validateInputs(input);
  if (!validation.success) {
    return validation;
  }

  const { iface, functionFragment, chainId } = validation.data;

  const userId = await getRpcPreferenceUserId(input._context?.executionId);

  let rpcManager: RpcProviderManager;
  try {
    rpcManager = await getRpcProvider({ chainId, userId });
  } catch (error) {
    return {
      success: false,
      destinationError: true,
      error: getErrorMessage(error),
    };
  }

  const blockRangeResult = await rpcManager.executeWithFailover(
    async (provider) =>
      resolveBlockRange(
        provider,
        input.fromBlock,
        input.toBlock,
        input.blockCount
      )
  );
  if (!blockRangeResult.success) {
    return { success: false, error: blockRangeResult.error };
  }
  const { range } = blockRangeResult;

  const explorerConfig = await db.query.explorerConfigs.findFirst({
    where: eq(explorerConfigs.chainId, chainId),
  });

  if (!explorerConfig) {
    return {
      success: false,
      destinationError: true,
      error: `No explorer configuration found for chain ${chainId}`,
    };
  }

  const contractAddressLink = getAddressUrl(
    explorerConfig,
    input.contractAddress
  );

  if (range.fromBlock > range.toBlock) {
    return {
      success: true,
      transactions: [],
      fromBlock: range.fromBlock,
      toBlock: range.toBlock,
      totalFetched: 0,
      matchCount: 0,
      contractAddressLink,
    };
  }

  const txResult = await fetchContractTransactions(
    explorerConfig,
    input.contractAddress,
    chainId,
    range.fromBlock,
    range.toBlock,
    ETHERSCAN_API_KEY
  );

  if (!txResult.success) {
    return { success: false, error: txResult.error };
  }

  const urlConfig = resolveExplorerUrlConfig(explorerConfig, txResult.usedBackup);
  const filterArgs = parseFunctionArgsFilter(input.functionArgs);

  const { matched, totalFiltered } = filterAndDecodeTransactions(
    txResult.transactions,
    input.contractAddress,
    iface,
    functionFragment,
    filterArgs,
    (hash: string) => getTransactionUrl(urlConfig, hash)
  );

  return {
    success: true,
    transactions: matched,
    fromBlock: range.fromBlock,
    toBlock: range.toBlock,
    totalFetched: totalFiltered,
    matchCount: matched.length,
    contractAddressLink,
  };
}
