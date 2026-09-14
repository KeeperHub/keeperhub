import type { Commitment } from "@solana/web3.js";
import type { Endpoint } from "./ingest/solana-connection";

/**
 * The in-memory registration shapes the reconciler builds from discovery and
 * hands to a per-chain BlockIngestor. One `ChainRegistration` per Solana chain
 * carries every event trigger (matched against block txs by programId) and
 * every block trigger (fired on blockHeight cadence) for that chain, plus the
 * resolved RPC/WSS endpoints.
 */

export interface SolanaEventTrigger {
  workflowId: string;
  userId: string;
  workflowName: string;
  programId: string;
  /** Anchor IDL JSON for typed decoding; absent -> raw log mode. */
  idl?: string;
  /** Anchor event name to match in typed mode; absent -> fire on any tx. */
  eventName?: string;
  configHash: string;
}

export interface SolanaBlockTrigger {
  workflowId: string;
  userId: string;
  workflowName: string;
  blockInterval: number;
  configHash: string;
}

export interface ChainRegistration {
  chainId: number;
  /**
   * Carried purely for observability: it labels the chain's metrics so the
   * Grafana rules can page at P2 for mainnet and P3 for testnet without a
   * hardcoded chain-id list that rots the moment a chain is added. Not part of
   * `configHash`, so it can never trigger a spurious ingestor restart.
   */
  isTestnet: boolean;
  rpcUrl: string;
  fallbackRpcUrl?: string;
  wssUrl: string;
  fallbackWssUrl?: string;
  commitment: Commitment;
  /**
   * Ingestion strategy. "getblock" (default) serves event + block triggers;
   * "signatures" is the getSignaturesForAddress / eth_getLogs analog (event
   * triggers only). Geyser overrides both when an endpoint is set.
   */
  sourceMode?: "getblock" | "signatures";
  /**
   * Optional Geyser/gRPC endpoint. When set, the ingestor uses the server-side
   * filtered stream (mainnet path) instead of getBlock polling. Not populated
   * yet - a future chains-config field selects it per chain.
   */
  geyserEndpoint?: string;
  geyserToken?: string;
  eventTriggers: SolanaEventTrigger[];
  blockTriggers: SolanaBlockTrigger[];
  /**
   * Hash over everything that affects ingestion for this chain (endpoints,
   * commitment, and the sorted per-trigger configHashes). The reconciler
   * restarts a chain's ingestor when this changes.
   */
  configHash: string;
}

/**
 * The endpoint list a chain's connection rotates through: primary first, then
 * the fallback when one is configured.
 *
 * Shared so the reconciler can describe a chain that failed to start using the
 * same endpoints the ingestor would have used, rather than duplicating the
 * fallback logic and drifting from it.
 */
export function registrationEndpoints(
  registration: ChainRegistration,
): Endpoint[] {
  const endpoints: Endpoint[] = [
    { rpcUrl: registration.rpcUrl, wssUrl: registration.wssUrl },
  ];
  if (registration.fallbackWssUrl) {
    endpoints.push({
      rpcUrl: registration.fallbackRpcUrl ?? registration.rpcUrl,
      wssUrl: registration.fallbackWssUrl,
    });
  }
  return endpoints;
}
