/**
 * Explorer service for building URLs and fetching ABIs
 *
 * Supports multiple explorer types:
 * - etherscan: Etherscan API v2 (Ethereum, Base, Arbitrum, etc.)
 * - blockscout: Blockscout API (Tempo, etc.)
 * - solscan: Solana (IDL fetch not supported via API)
 */

import { joinExplorerUrl } from "@/lib/build-explorer-url";
import type { ExplorerConfig } from "@/lib/db/schema";
import { sleep } from "@/lib/sleep";
import {
  type BlockscoutTransaction,
  fetchBlockscoutAbi,
  fetchBlockscoutTransactions,
} from "./blockscout";
import type { AbiResult } from "./etherscan";
import {
  type EtherscanTransaction,
  fetchEtherscanAbi,
  fetchEtherscanTransactions,
} from "./etherscan";

export type NormalizedTransaction = {
  hash: string;
  from: string;
  to: string;
  value: string;
  input: string;
  blockNumber: number;
  timestamp: string;
  isError: boolean;
};

type ProviderResult =
  | { success: true; transactions: NormalizedTransaction[] }
  | { success: false; error: string };

export type TransactionListResult =
  | {
      success: true;
      transactions: NormalizedTransaction[];
      usedBackup: boolean;
    }
  | { success: false; error: string };

/**
 * Build transaction URL for the explorer
 */
export function getTransactionUrl(
  config: ExplorerConfig,
  txHash: string
): string {
  if (!config.explorerUrl) {
    return "";
  }
  const path = config.explorerTxPath || "/tx/{hash}";
  return joinExplorerUrl(config.explorerUrl, path.replace("{hash}", txHash));
}

/**
 * Build address URL for the explorer
 */
export function getAddressUrl(config: ExplorerConfig, address: string): string {
  if (!config.explorerUrl) {
    return "";
  }
  const path = config.explorerAddressPath || "/address/{address}";
  return joinExplorerUrl(
    config.explorerUrl,
    path.replace("{address}", address)
  );
}

/**
 * Build contract/ABI URL for the explorer
 */
export function getContractUrl(
  config: ExplorerConfig,
  address: string
): string {
  if (!config.explorerUrl) {
    return "";
  }

  if (config.explorerContractPath) {
    return joinExplorerUrl(
      config.explorerUrl,
      config.explorerContractPath.replace("{address}", address)
    );
  }

  // Fallback defaults based on chain type
  if (config.chainType === "solana") {
    return joinExplorerUrl(
      config.explorerUrl,
      `/account/${address}#anchorProgramIDL`
    );
  }
  return joinExplorerUrl(config.explorerUrl, `/address/${address}#code`);
}

/**
 * Fetch ABI for a contract from the explorer API
 *
 * @param config - Explorer configuration from database
 * @param contractAddress - Contract address to fetch ABI for
 * @param chainId - Chain ID (required for Etherscan v2)
 * @param apiKey - Optional API key (required for Etherscan)
 */
export async function fetchContractAbi(
  config: ExplorerConfig,
  contractAddress: string,
  chainId: number,
  apiKey?: string
): Promise<AbiResult> {
  if (!(config.explorerApiUrl && config.explorerApiType)) {
    return {
      success: false,
      error: "Explorer API not configured for this chain",
    };
  }

  switch (config.explorerApiType) {
    case "etherscan":
      return await fetchEtherscanAbi(
        config.explorerApiUrl,
        chainId,
        contractAddress,
        apiKey
      );

    case "blockscout":
      return await fetchBlockscoutAbi(
        config.explorerApiUrl,
        contractAddress,
        apiKey
      );

    case "solscan":
      return {
        success: false,
        error:
          "Solana IDL fetch not supported via API. Use Anchor CLI instead.",
      };

    default:
      return {
        success: false,
        error: `Unknown explorer type: ${config.explorerApiType}`,
      };
  }
}

function normalizeEtherscanTx(tx: EtherscanTransaction): NormalizedTransaction {
  return {
    hash: tx.hash,
    from: tx.from,
    to: tx.to,
    value: tx.value,
    input: tx.input,
    blockNumber: Number.parseInt(tx.blockNumber, 10),
    timestamp: tx.timeStamp,
    isError: tx.isError === "1",
  };
}

function normalizeBlockscoutTx(
  tx: BlockscoutTransaction
): NormalizedTransaction {
  return {
    hash: tx.hash,
    from: tx.from.hash,
    // Contract creation txs have null `to`; normalized to "" so they
    // are filtered out by filterAndDecodeTransactions (address mismatch).
    to: tx.to?.hash ?? "",
    value: tx.value,
    input: tx.raw_input,
    blockNumber: tx.block,
    timestamp: tx.timestamp,
    isError: tx.status !== "ok",
  };
}

async function fetchTransactionsFromProvider(
  apiType: string,
  apiUrl: string,
  contractAddress: string,
  chainId: number,
  startBlock: number,
  endBlock: number,
  apiKey?: string
): Promise<ProviderResult> {
  switch (apiType) {
    case "etherscan": {
      const result = await fetchEtherscanTransactions(
        apiUrl,
        chainId,
        contractAddress,
        startBlock,
        endBlock,
        apiKey
      );
      if (!result.success) {
        return result;
      }
      return {
        success: true,
        transactions: result.transactions.map(normalizeEtherscanTx),
      };
    }

    case "blockscout": {
      const result = await fetchBlockscoutTransactions(
        apiUrl,
        contractAddress,
        startBlock,
        endBlock,
        apiKey
      );
      if (!result.success) {
        return result;
      }
      return {
        success: true,
        transactions: result.transactions.map(normalizeBlockscoutTx),
      };
    }

    default:
      return {
        success: false,
        error: `Transaction listing not supported for explorer type: ${apiType}`,
      };
  }
}

const RETRY_BACKOFF_MS = 10_000;
const RETRY_ROUNDS = 2;

/**
 * Fetch transaction list for a contract address from the appropriate explorer.
 *
 * When a backup provider is configured the function runs up to RETRY_ROUNDS
 * rounds of (primary -> backup) with a RETRY_BACKOFF_MS pause between rounds,
 * so a transient double-failure on both providers within the same window can
 * self-heal on the next round without the caller having to retry. Rate-limiting
 * is the most common cause of simultaneous failures, so the backoff is
 * intentionally long (10 s) to avoid amplifying the problem.
 *
 * When all attempts fail the error message surfaces both providers' last errors
 * so callers can distinguish e.g. "primary rate-limited, backup bad key" from
 * a uniform outage.
 */
export async function fetchContractTransactions(
  config: ExplorerConfig,
  contractAddress: string,
  chainId: number,
  startBlock: number,
  endBlock: number,
  apiKey?: string
): Promise<TransactionListResult> {
  if (!(config.explorerApiUrl && config.explorerApiType)) {
    return {
      success: false,
      error: "Explorer API not configured for this chain",
    };
  }

  const backup =
    config.backupExplorerApiType != null && config.backupExplorerApiUrl != null
      ? {
          apiType: config.backupExplorerApiType,
          apiUrl: config.backupExplorerApiUrl,
          apiKey: config.backupExplorerApiKey ?? undefined,
          apiKeyNeeded: config.backupExplorerApiKeyNeeded,
        }
      : null;

  let lastPrimaryError: string | undefined;
  let lastBackupError: string | undefined;

  for (let round = 0; round < RETRY_ROUNDS; round++) {
    if (round > 0) {
      await sleep(RETRY_BACKOFF_MS);
    }

    const primaryResult = await fetchTransactionsFromProvider(
      config.explorerApiType,
      config.explorerApiUrl,
      contractAddress,
      chainId,
      startBlock,
      endBlock,
      apiKey
    );

    if (primaryResult.success) {
      return { ...primaryResult, usedBackup: false };
    }

    lastPrimaryError = primaryResult.error;

    if (backup === null) {
      continue;
    }

    if (backup.apiKeyNeeded && !backup.apiKey) {
      lastBackupError =
        "Backup explorer requires an API key but none is configured";
      break;
    }

    const backupResult = await fetchTransactionsFromProvider(
      backup.apiType,
      backup.apiUrl,
      contractAddress,
      chainId,
      startBlock,
      endBlock,
      backup.apiKey
    );

    if (backupResult.success) {
      return { ...backupResult, usedBackup: true };
    }

    lastBackupError = backupResult.error;
  }

  if (lastBackupError !== undefined) {
    return {
      success: false,
      error: `All explorer providers failed. Primary: ${lastPrimaryError}. Backup: ${lastBackupError}`,
    };
  }

  return {
    success: false,
    error: lastPrimaryError ?? "Explorer request failed",
  };
}

/**
 * Returns an ExplorerConfig-shaped object with the URL and path fields
 * resolved to the backup provider when it was used. Falls back to primary
 * values for any backup field that is not configured.
 */
export function resolveExplorerUrlConfig(
  config: ExplorerConfig,
  usedBackup: boolean
): ExplorerConfig {
  if (!usedBackup) {
    return config;
  }
  return {
    ...config,
    explorerUrl: config.backupExplorerUrl ?? config.explorerUrl,
    explorerTxPath: config.backupExplorerTxPath ?? config.explorerTxPath,
    explorerAddressPath:
      config.backupExplorerAddressPath ?? config.explorerAddressPath,
    explorerContractPath:
      config.backupExplorerContractPath ?? config.explorerContractPath,
  };
}
