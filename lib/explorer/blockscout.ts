/**
 * Blockscout API integration
 *
 * Provides ABI fetching and transaction listing for Blockscout-based
 * explorers (e.g., Tempo). Self-hosted instances typically don't require
 * an API key; hosted multichain instances (e.g., api.blockscout.com) do.
 */

import { sleep } from "@/lib/sleep";

type BlockscoutResponse = {
  status: string;
  message: string;
  result: string;
};

export type AbiResult = {
  success: boolean;
  abi?: unknown[];
  error?: string;
};

/**
 * Fetch ABI from Blockscout API
 *
 * @param apiUrl - Base API URL (e.g., "https://explorer.tempo.xyz/api")
 * @param contractAddress - Contract address to fetch ABI for
 * @param apiKey - Optional Blockscout API key (required by hosted multichain instances like api.blockscout.com)
 */
export async function fetchBlockscoutAbi(
  apiUrl: string,
  contractAddress: string,
  apiKey?: string
): Promise<AbiResult> {
  const params = new URLSearchParams({
    module: "contract",
    action: "getabi",
    address: contractAddress,
  });

  if (apiKey) {
    params.set("apikey", apiKey);
  }

  try {
    const response = await fetch(`${apiUrl}?${params}`);
    const data: BlockscoutResponse = await response.json();

    if (data.status !== "1") {
      // Parse common Blockscout error messages
      const errorMessage = parseBlockscoutError(data.result || data.message);
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

export type BlockscoutTransaction = {
  hash: string;
  from: { hash: string };
  to: { hash: string } | null;
  value: string;
  raw_input: string;
  block: number;
  timestamp: string;
  status: string;
  method: string | null;
};

type BlockscoutTxListResponse = {
  items: BlockscoutTransaction[];
  next_page_params: { block_number: number; index: number } | null;
};

const BLOCKSCOUT_TX_PAGE_SIZE = 50;
const MAX_TX_RESULTS = 50_000;
const BLOCKSCOUT_PAGE_DELAY_MS = 100;
const API_V1_SUFFIX_PATTERN = /\/api\/?$/;

type BlockscoutCursor = { block_number: number; index: number };

function buildBlockscoutTxUrl(
  baseUrl: string,
  contractAddress: string,
  cursor: BlockscoutCursor | null,
  apiKey?: string
): string {
  const url = new URL(`${baseUrl}/addresses/${contractAddress}/transactions`);
  url.searchParams.set("filter", "to");

  if (cursor) {
    url.searchParams.set("block_number", cursor.block_number.toString());
    url.searchParams.set("index", cursor.index.toString());
  }

  if (apiKey) {
    url.searchParams.set("apikey", apiKey);
  }

  return url.toString();
}

function shouldStopPaginating(
  data: BlockscoutTxListResponse,
  totalCollected: number,
  startBlock: number
): boolean {
  if (totalCollected >= MAX_TX_RESULTS) {
    return true;
  }
  if (!data.next_page_params || data.items.length < BLOCKSCOUT_TX_PAGE_SIZE) {
    return true;
  }
  const lastBlock = data.items.at(-1)?.block ?? 0;
  return lastBlock < startBlock;
}

/**
 * Check if all items on the current page are above the endBlock.
 * If so, the page contains only irrelevant future transactions and
 * we should continue paginating without collecting any items, rather
 * than stopping early.
 */
function isPageEntirelyAboveEndBlock(
  items: BlockscoutTransaction[],
  endBlock: number
): boolean {
  if (items.length === 0) {
    return false;
  }
  const lowestBlockOnPage = items.at(-1)?.block ?? 0;
  return lowestBlockOnPage > endBlock;
}

function collectInRangeTransactions(
  items: BlockscoutTransaction[],
  startBlock: number,
  endBlock: number,
  out: BlockscoutTransaction[]
): void {
  if (isPageEntirelyAboveEndBlock(items, endBlock)) {
    return;
  }
  for (const tx of items) {
    if (tx.block >= startBlock && tx.block <= endBlock) {
      out.push(tx);
    }
  }
}

type BlockscoutTxResult =
  | { success: true; transactions: BlockscoutTransaction[] }
  | { success: false; error: string };

async function fetchPage(
  baseUrl: string,
  contractAddress: string,
  cursor: BlockscoutCursor | null,
  apiKey?: string
): Promise<
  { ok: true; data: BlockscoutTxListResponse } | { ok: false; error: string }
> {
  const url = buildBlockscoutTxUrl(baseUrl, contractAddress, cursor, apiKey);
  const response = await fetch(url);

  if (!response.ok) {
    return {
      ok: false,
      error: `Blockscout API returned status ${response.status}`,
    };
  }

  const data: BlockscoutTxListResponse = await response.json();
  return { ok: true, data };
}

/**
 * Fetch transaction list for a contract address from Blockscout API v2
 *
 * Uses the `/addresses/:address/transactions` endpoint.
 * Paginates automatically using cursor-based pagination.
 *
 * @param apiUrl - Base API URL (e.g., "https://explorer.tempo.xyz/api")
 * @param contractAddress - Contract address to list transactions for
 * @param startBlock - Start block number (used for client-side filtering)
 * @param endBlock - End block number (used for client-side filtering)
 * @param apiKey - Optional Blockscout API key (required by hosted multichain instances like api.blockscout.com)
 */
export async function fetchBlockscoutTransactions(
  apiUrl: string,
  contractAddress: string,
  startBlock: number,
  endBlock: number,
  apiKey?: string
): Promise<BlockscoutTxResult> {
  const allTransactions: BlockscoutTransaction[] = [];
  let cursor: BlockscoutCursor | null = null;

  try {
    const baseUrl = apiUrl.replace(API_V1_SUFFIX_PATTERN, "/api/v2");

    let pageCount = 0;
    for (;;) {
      if (pageCount > 0) {
        await sleep(BLOCKSCOUT_PAGE_DELAY_MS);
      }
      pageCount++;

      const page = await fetchPage(baseUrl, contractAddress, cursor, apiKey);
      if (!page.ok) {
        return { success: false, error: page.error };
      }

      collectInRangeTransactions(
        page.data.items,
        startBlock,
        endBlock,
        allTransactions
      );

      if (shouldStopPaginating(page.data, allTransactions.length, startBlock)) {
        break;
      }

      cursor = page.data.next_page_params;
    }
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Unknown error fetching transactions",
    };
  }

  return { success: true, transactions: allTransactions };
}

/**
 * Parse Blockscout error messages into user-friendly messages
 */
function parseBlockscoutError(message: string): string {
  const lowerMessage = message.toLowerCase();

  if (lowerMessage.includes("contract source code not verified")) {
    return "Contract source code is not verified on the block explorer";
  }

  if (lowerMessage.includes("invalid address")) {
    return "Invalid contract address";
  }

  return message || "Failed to fetch ABI from Blockscout";
}
