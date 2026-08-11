import { createHash } from "node:crypto";
import { type Commitment, PublicKey } from "@solana/web3.js";
import type { DiscoveryData, NetworkConfig, RawWorkflow } from "../lib/types";
import { logger } from "../lib/utils/logger";
import type {
  ChainRegistration,
  SolanaBlockTrigger,
  SolanaEventTrigger,
} from "./registrations";

function sha256(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function isWsUrl(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (value.startsWith("wss://") || value.startsWith("ws://"))
  );
}

function chainIdOf(workflow: RawWorkflow): number | null {
  const raw = workflow.nodes?.[0]?.data?.config?.network;
  if (typeof raw !== "string") {
    return null;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function toEventTrigger(
  workflow: RawWorkflow,
): Omit<SolanaEventTrigger, "configHash"> | null {
  const id = typeof workflow.id === "string" ? workflow.id : null;
  const config = workflow.nodes?.[0]?.data?.config;
  const programId =
    typeof config?.programId === "string" ? config.programId : null;
  if (!id || !programId) {
    return null;
  }
  try {
    new PublicKey(programId);
  } catch {
    logger.warn(
      `[mapper] event workflow ${id} programId "${programId}" is not valid base58; skipping`,
    );
    return null;
  }
  return {
    workflowId: id,
    userId: typeof workflow.userId === "string" ? workflow.userId : "",
    workflowName: typeof workflow.name === "string" ? workflow.name : "",
    programId,
    idl: typeof config?.idl === "string" ? config.idl : undefined,
    eventName:
      typeof config?.eventName === "string" ? config.eventName : undefined,
  };
}

function toBlockTrigger(
  workflow: RawWorkflow,
): Omit<SolanaBlockTrigger, "configHash"> | null {
  const id = typeof workflow.id === "string" ? workflow.id : null;
  const config = workflow.nodes?.[0]?.data?.config;
  if (!id) {
    return null;
  }
  const interval = Number(config?.blockInterval);
  const blockInterval =
    Number.isFinite(interval) && interval > 0 ? Math.floor(interval) : 1;
  return {
    workflowId: id,
    userId: typeof workflow.userId === "string" ? workflow.userId : "",
    workflowName: typeof workflow.name === "string" ? workflow.name : "",
    blockInterval,
  };
}

interface ChainEndpoints {
  rpcUrl: string;
  fallbackRpcUrl?: string;
  wssUrl: string;
  fallbackWssUrl?: string;
  commitment: Commitment;
}

/** Resolves and validates the RPC + WSS a Solana chain needs, or null. */
function resolveEndpoints(
  network: NetworkConfig | undefined,
  chainId: number,
): ChainEndpoints | null {
  if (!network || network.chainType !== "solana") {
    return null;
  }
  const rpcUrl = network.defaultPrimaryRpc;
  if (typeof rpcUrl !== "string" || rpcUrl.length === 0) {
    logger.warn(`[mapper] chain ${chainId} has no defaultPrimaryRpc; skipping`);
    return null;
  }
  const wssUrl = network.defaultPrimaryWss;
  if (!isWsUrl(wssUrl)) {
    logger.warn(
      `[mapper] chain ${chainId} defaultPrimaryWss missing/invalid (needed for slotSubscribe); skipping`,
    );
    return null;
  }
  const rawFallbackRpc = network.defaultFallbackRpc;
  const rawFallbackWss = network.defaultFallbackWss;
  return {
    rpcUrl,
    fallbackRpcUrl:
      typeof rawFallbackRpc === "string" && rawFallbackRpc.length > 0
        ? rawFallbackRpc
        : undefined,
    wssUrl,
    fallbackWssUrl: isWsUrl(rawFallbackWss) ? rawFallbackWss : undefined,
    commitment: "confirmed",
  };
}

/**
 * Builds one ChainRegistration per Solana chain that has at least one valid
 * event or block trigger and resolvable endpoints. Malformed triggers and
 * chains missing RPC/WSS are skipped-and-logged, never thrown.
 */
export function buildRegistrations(data: DiscoveryData): ChainRegistration[] {
  const eventsByChain = new Map<
    number,
    Omit<SolanaEventTrigger, "configHash">[]
  >();
  const blocksByChain = new Map<
    number,
    Omit<SolanaBlockTrigger, "configHash">[]
  >();

  for (const wf of data.eventWorkflows) {
    const chainId = chainIdOf(wf);
    const trigger = chainId === null ? null : toEventTrigger(wf);
    if (chainId !== null && trigger) {
      const list = eventsByChain.get(chainId) ?? [];
      list.push(trigger);
      eventsByChain.set(chainId, list);
    }
  }
  for (const wf of data.blockWorkflows) {
    const chainId = chainIdOf(wf);
    const trigger = chainId === null ? null : toBlockTrigger(wf);
    if (chainId !== null && trigger) {
      const list = blocksByChain.get(chainId) ?? [];
      list.push(trigger);
      blocksByChain.set(chainId, list);
    }
  }

  const chainIds = new Set<number>([
    ...eventsByChain.keys(),
    ...blocksByChain.keys(),
  ]);
  // Ingestion strategy lever. Global env override for now; a future per-chain
  // chains-config field replaces this. "signatures" runs the eth_getLogs-style
  // filtered-query source for event triggers.
  const sourceMode =
    process.env.SOLANA_SOURCE_MODE === "signatures"
      ? ("signatures" as const)
      : undefined;
  const registrations: ChainRegistration[] = [];

  for (const chainId of chainIds) {
    const endpoints = resolveEndpoints(data.networks[chainId], chainId);
    if (!endpoints) {
      continue;
    }
    const eventTriggers: SolanaEventTrigger[] = (
      eventsByChain.get(chainId) ?? []
    ).map((t) => ({ ...t, configHash: sha256(t) }));
    const blockTriggers: SolanaBlockTrigger[] = (
      blocksByChain.get(chainId) ?? []
    ).map((t) => ({ ...t, configHash: sha256(t) }));

    const configHash = sha256({
      endpoints,
      sourceMode: sourceMode ?? null,
      events: eventTriggers.map((t) => t.configHash).sort(),
      blocks: blockTriggers.map((t) => t.configHash).sort(),
    });

    registrations.push({
      chainId,
      ...endpoints,
      sourceMode,
      eventTriggers,
      blockTriggers,
      configHash,
    });
  }

  return registrations;
}
