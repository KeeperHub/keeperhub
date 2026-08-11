import "server-only";

import { eq } from "drizzle-orm";
import { ethers } from "ethers";
import { db } from "@/lib/db";
import { explorerConfigs, workflowExecutions } from "@/lib/db/schema";
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
import { getErrorMessage } from "@/lib/utils";

const DEFAULT_BLOCK_LOOKBACK = 6500;
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
      transactions: DecodedTransaction[];
      fromBlock: number;
      toBlock: number;
      totalFetched: number;
      matchCount: number;
      contractAddressLink: string;
    }
  | { success: false; error: string };

export type QueryTransactionsCoreInput = {
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

async function getUserIdFromExecution(
  executionId: string | undefined
): Promise<string | undefined> {
  if (!executionId) {
    return;
  }

  const execution = await db
    .select({ userId: workflowExecutions.userId })
    .from(workflowExecutions)
    .where(eq(workflowExecutions.id, executionId))
    .limit(1);

  return execution[0]?.userId;
}

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

function parseBlockCount(
  blockCountInput: number | string | undefined
): { success: true; value: number } | { success: false; error: string } | null {
  if (blockCountInput === undefined || blockCountInput === null) {
    return null;
  }

  const strVal =
    typeof blockCountInput === "string" ? blockCountInput.trim() : "";
  if (typeof blockCountInput === "string" && strVal === "") {
    return null;
  }

  const parsed =
    typeof blockCountInput === "number"
      ? blockCountInput
      : Number.parseInt(strVal, 10);

  if (Number.isNaN(parsed) || parsed <= 0) {
    return {
      success: false,
      error: `Invalid blockCount value: ${blockCountInput}`,
    };
  }

  return { success: true, value: parsed };
}

function resolveFromBlock(
  fromBlockInput: string | undefined,
  blockCountInput: number | string | undefined,
  resolvedToBlock: number
): { success: true; value: number } | { success: false; error: string } {
  const fromBlockStr = fromBlockInput?.toString().trim() ?? "";

  if (fromBlockStr !== "") {
    const parsed = Number.parseInt(fromBlockStr, 10);
    if (Number.isNaN(parsed)) {
      return {
        success: false,
        error: `Invalid fromBlock value: ${fromBlockInput}`,
      };
    }
    return { success: true, value: parsed };
  }

  const blockCountResult = parseBlockCount(blockCountInput);
  if (blockCountResult !== null && !blockCountResult.success) {
    return { success: false, error: blockCountResult.error };
  }

  const lookback =
    blockCountResult !== null ? blockCountResult.value : DEFAULT_BLOCK_LOOKBACK;

  return { success: true, value: Math.max(0, resolvedToBlock - lookback) };
}

type BlockRange = { fromBlock: number; toBlock: number };

async function resolveBlockRange(
  provider: ethers.JsonRpcProvider,
  fromBlockInput: string | undefined,
  toBlockInput: string | undefined,
  blockCountInput: number | string | undefined
): Promise<
  { success: true; range: BlockRange } | { success: false; error: string }
> {
  const toBlockStr = toBlockInput?.toString().trim() ?? "";
  let resolvedToBlock: number;

  if (toBlockStr === "" || toBlockStr.toLowerCase() === "latest") {
    resolvedToBlock = await provider.getBlockNumber();
  } else {
    resolvedToBlock = Number.parseInt(toBlockStr, 10);
    if (Number.isNaN(resolvedToBlock)) {
      return {
        success: false,
        error: `Invalid toBlock value: ${toBlockInput}`,
      };
    }
  }

  const fromBlockResult = resolveFromBlock(
    fromBlockInput,
    blockCountInput,
    resolvedToBlock
  );
  if (!fromBlockResult.success) {
    return { success: false, error: fromBlockResult.error };
  }

  return {
    success: true,
    range: { fromBlock: fromBlockResult.value, toBlock: resolvedToBlock },
  };
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
): { success: true; data: ValidatedInput } | { success: false; error: string } {
  const { contractAddress, abi, abiFunction } = input;

  if (!ethers.isAddress(contractAddress)) {
    return {
      success: false,
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

  let chainId: number;
  try {
    chainId = getChainIdFromNetwork(input.network);
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }

  return {
    success: true,
    data: { iface, functionFragment, chainId },
  };
}

export async function queryTransactionsCore(
  input: QueryTransactionsCoreInput
): Promise<QueryTransactionsResult> {
  const validation = validateInputs(input);
  if (!validation.success) {
    return { success: false, error: validation.error };
  }

  const { iface, functionFragment, chainId } = validation.data;

  const userId = await getUserIdFromExecution(input._context?.executionId);

  let rpcManager: RpcProviderManager;
  try {
    rpcManager = await getRpcProvider({ chainId, userId });
  } catch (error) {
    return {
      success: false,
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
