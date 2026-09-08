/**
 * Etherscan API v2 integration
 *
 * Provides ABI fetching, source code metadata, and transaction listing
 * for Ethereum, Base, Arbitrum, and other Etherscan-supported chains.
 */

import { sleep } from "@/lib/sleep";

type EtherscanResponse = {
  status: string;
  message: string;
  result: string;
};

type EtherscanSourceCodeResponse = {
  status: string;
  message: string;
  result: Array<{
    Proxy?: string;
    Implementation?: string;
    ABI?: string;
    ContractName?: string;
    Facets?: string;
    IsDiamond?: string;
    [key: string]: unknown;
  }>;
};

export type AbiResult = {
  success: boolean;
  abi?: unknown[];
  error?: string;
};

export type SourceCodeResult = {
  success: boolean;
  isProxy?: boolean;
  isDiamond?: boolean;
  implementationAddress?: string;
  facetAddresses?: string[];
  contractName?: string;
  proxyAbi?: string;
  error?: string;
};

/**
 * Fetch ABI from Etherscan API v2
 *
 * @param apiUrl - Base API URL (e.g., "https://api.etherscan.io/v2/api")
 * @param chainId - Chain ID for the request
 * @param contractAddress - Contract address to fetch ABI for
 * @param apiKey - Optional Etherscan API key (recommended for rate limits)
 */
export async function fetchEtherscanAbi(
  apiUrl: string,
  chainId: number,
  contractAddress: string,
  apiKey?: string
): Promise<AbiResult> {
  const params = new URLSearchParams({
    chainid: chainId.toString(),
    module: "contract",
    action: "getabi",
    address: contractAddress,
  });

  if (apiKey) {
    params.set("apikey", apiKey);
  }

  try {
    const response = await fetch(`${apiUrl}?${params}`);
    const data: EtherscanResponse = await response.json();

    if (data.status !== "1") {
      // Parse common Etherscan error messages
      const errorMessage = parseEtherscanError(data.result || data.message);
      return {
        success: false,
        error: errorMessage,
      };
    }

    const abi = JSON.parse(data.result);
    return { success: true, abi };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Fetch source code and proxy metadata from Etherscan API v2
 *
 * @param apiUrl - Base API URL (e.g., "https://api.etherscan.io/v2/api")
 * @param chainId - Chain ID for the request
 * @param contractAddress - Contract address to fetch source code for
 * @param apiKey - Optional Etherscan API key (recommended for rate limits)
 */
export async function fetchEtherscanSourceCode(
  apiUrl: string,
  chainId: number,
  contractAddress: string,
  apiKey?: string
): Promise<SourceCodeResult> {
  const params = new URLSearchParams({
    chainid: chainId.toString(),
    module: "contract",
    action: "getsourcecode",
    address: contractAddress,
  });

  if (apiKey) {
    params.set("apikey", apiKey);
  }

  try {
    const response = await fetch(`${apiUrl}?${params}`);
    const data: EtherscanSourceCodeResponse = await response.json();

    if (data.status !== "1") {
      const errorMessage = parseEtherscanError(
        data.message || "Failed to fetch source code"
      );
      return {
        success: false,
        error: errorMessage,
      };
    }

    if (!data.result || data.result.length === 0) {
      return {
        success: false,
        error: "No source code data returned from Etherscan",
      };
    }

    const contractData = data.result[0];
    const isProxy = contractData.Proxy === "1";
    const isDiamond = contractData.IsDiamond === "1";
    const implementationAddress = contractData.Implementation;
    const contractName = contractData.ContractName;

    // Parse facet addresses if this is a Diamond contract
    let facetAddresses: string[] | undefined;
    if (isDiamond && contractData.Facets) {
      facetAddresses = contractData.Facets.split(",")
        .map((addr) => addr.trim())
        .filter((addr) => addr.length > 0);
    }

    return {
      success: true,
      isProxy,
      isDiamond,
      implementationAddress: implementationAddress || undefined,
      facetAddresses,
      contractName: contractName || undefined,
      proxyAbi: contractData.ABI || undefined,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

export type EtherscanTransaction = {
  hash: string;
  from: string;
  to: string;
  value: string;
  input: string;
  blockNumber: string;
  timeStamp: string;
  isError: string;
  functionName: string;
};

type EtherscanTxListResponse = {
  status: string;
  message: string;
  result: EtherscanTransaction[] | string;
};

// Etherscan caps txlist at 10,000 records per query and rejects any page where
// page * offset > 10,000, so a single request can never return more than the
// first 10,000 transactions of a range. To cover a wider range we walk it in
// block-cursor windows: each request pulls up to 10,000 records ascending, then
// the next request resumes from the highest block seen until the whole range is
// covered. MAX_TX_WINDOWS bounds the request budget so a pathologically busy
// range cannot loop unbounded against the API.
const ETHERSCAN_TX_OFFSET = 10_000;
const MAX_TX_WINDOWS = 30;
const ETHERSCAN_PAGE_DELAY_MS = 220;

type TxPageResult =
  | { done: false; transactions: EtherscanTransaction[] }
  | { done: true; transactions: EtherscanTransaction[] }
  | { error: string };

function buildTxListParams(
  apiUrl: string,
  chainId: number,
  contractAddress: string,
  startBlock: number,
  endBlock: number,
  apiKey?: string
): string {
  const params = new URLSearchParams({
    chainid: chainId.toString(),
    module: "account",
    action: "txlist",
    address: contractAddress,
    startblock: startBlock.toString(),
    endblock: endBlock.toString(),
    // page=1 with a full 10,000 offset keeps every request inside Etherscan's
    // page * offset <= 10,000 limit; the block cursor (startblock) is what
    // advances across windows. Ascending order makes that cursor monotonic.
    page: "1",
    offset: ETHERSCAN_TX_OFFSET.toString(),
    sort: "asc",
  });

  if (apiKey) {
    params.set("apikey", apiKey);
  }

  return `${apiUrl}?${params}`;
}

function isEmptyTxListResult(data: EtherscanTxListResponse): boolean {
  if (Array.isArray(data.result) && data.result.length === 0) {
    return true;
  }
  if (typeof data.result !== "string") {
    return false;
  }
  const lower = data.result.toLowerCase();
  return (
    lower.includes("no transactions found") ||
    lower.includes("no records found")
  );
}

// Etherscan returns this once page * offset exceeds 10,000. It marks the end of
// the reachable window, so stop paginating and keep what was already collected
// rather than failing the whole fetch and discarding earlier pages.
function isWindowExhausted(data: EtherscanTxListResponse): boolean {
  const message = typeof data.result === "string" ? data.result : data.message;
  return (message ?? "").toLowerCase().includes("result window is too large");
}

function parseTxListResponse(data: EtherscanTxListResponse): TxPageResult {
  if (data.status !== "1") {
    if (isEmptyTxListResult(data) || isWindowExhausted(data)) {
      return { done: true, transactions: [] };
    }
    const errorMessage = parseEtherscanError(
      typeof data.result === "string" ? data.result : data.message
    );
    return { error: errorMessage };
  }

  if (!Array.isArray(data.result)) {
    return { done: true, transactions: [] };
  }

  const hasMore = data.result.length >= ETHERSCAN_TX_OFFSET;
  return { done: !hasMore, transactions: data.result };
}

async function fetchTxWindow(url: string): Promise<TxPageResult> {
  try {
    const response = await fetch(url);
    const data: EtherscanTxListResponse = await response.json();
    return parseTxListResponse(data);
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? error.message
          : "Unknown error fetching transactions",
    };
  }
}

// Accumulate a window's transactions into the running list, skipping hashes
// already collected (consecutive windows overlap on the cursor block), and
// report the highest block seen so the next window can resume from it.
function collectWindow(
  transactions: EtherscanTransaction[],
  seen: Set<string>,
  into: EtherscanTransaction[],
  cursorBlock: number
): number {
  let maxBlock = cursorBlock;
  for (const tx of transactions) {
    if (seen.has(tx.hash)) {
      continue;
    }
    seen.add(tx.hash);
    into.push(tx);
    const block = Number.parseInt(tx.blockNumber, 10);
    if (block > maxBlock) {
      maxBlock = block;
    }
  }
  return maxBlock;
}

/**
 * Fetch transaction list for a contract address from Etherscan API v2
 *
 * Uses the `account` module `txlist` action to get normal transactions.
 * Walks the block range in 10,000-record windows (up to MAX_TX_WINDOWS),
 * advancing a block cursor so ranges with more than 10,000 transactions are
 * fully covered rather than truncated at Etherscan's per-query cap.
 *
 * @param apiUrl - Base API URL (e.g., "https://api.etherscan.io/v2/api")
 * @param chainId - Chain ID for the request
 * @param contractAddress - Contract address to list transactions for
 * @param startBlock - Start block number
 * @param endBlock - End block number
 * @param apiKey - Optional Etherscan API key (recommended for rate limits)
 */
export async function fetchEtherscanTransactions(
  apiUrl: string,
  chainId: number,
  contractAddress: string,
  startBlock: number,
  endBlock: number,
  apiKey?: string
): Promise<
  | { success: true; transactions: EtherscanTransaction[] }
  | { success: false; error: string }
> {
  const allTransactions: EtherscanTransaction[] = [];
  const seenHashes = new Set<string>();
  let cursorBlock = startBlock;

  for (
    let window = 0;
    window < MAX_TX_WINDOWS && cursorBlock <= endBlock;
    window++
  ) {
    if (window > 0) {
      await sleep(ETHERSCAN_PAGE_DELAY_MS);
    }

    const url = buildTxListParams(
      apiUrl,
      chainId,
      contractAddress,
      cursorBlock,
      endBlock,
      apiKey
    );

    const result = await fetchTxWindow(url);
    if ("error" in result) {
      return { success: false, error: result.error };
    }

    const maxBlock = collectWindow(
      result.transactions,
      seenHashes,
      allTransactions,
      cursorBlock
    );

    if (result.done) {
      break;
    }

    // Full window: resume from the highest block seen so its remaining
    // transactions are picked up (overlap is de-duplicated by hash). If a
    // single block fills the whole window, step past it -- Etherscan cannot
    // page beyond 10,000 records within one block.
    cursorBlock = maxBlock > cursorBlock ? maxBlock : cursorBlock + 1;
  }

  return { success: true, transactions: allTransactions };
}

/**
 * Parse Etherscan error messages into user-friendly messages
 */
function parseEtherscanError(message: string): string {
  const lowerMessage = message.toLowerCase();

  if (lowerMessage.includes("contract source code not verified")) {
    return "Contract source code is not verified on the block explorer";
  }

  if (lowerMessage.includes("invalid api key")) {
    return "Invalid Etherscan API key";
  }

  if (lowerMessage.includes("rate limit")) {
    return "Rate limit exceeded. Please try again later.";
  }

  if (lowerMessage.includes("invalid address")) {
    return "Invalid contract address";
  }

  return message || "Failed to fetch ABI from Etherscan";
}
