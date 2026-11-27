import { createHash } from "node:crypto";
import { type Commitment, PublicKey } from "@solana/web3.js";
import type { DiscoveryData, NetworkConfig, RawWorkflow } from "../lib/types";
import { type LogSink, logger, silentLogger } from "../lib/utils/logger";
import type {
  ChainRegistration,
  RouteRegistration,
  RouteSpec,
  SolanaBlockTrigger,
  SolanaEventTrigger,
} from "./registrations";
import { parseRoute } from "./rpc-route/route";

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
  log: LogSink,
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
    log.warn(
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

type SourceMode = "getblock" | "signatures";

/**
 * Explicit operator override applied to every chain, for incident response and
 * for chains whose shape the default below gets wrong (e.g. a mainnet chain
 * watching so many programs that per-program signature queries cost more than
 * one whole-block pull). Any other value leaves selection to the default.
 */
function sourceModeOverride(): SourceMode | undefined {
  const raw = process.env.SOLANA_SOURCE_MODE?.trim().toLowerCase();
  if (!raw) {
    return undefined;
  }
  if (raw === "signatures" || raw === "getblock") {
    return raw;
  }
  // Unrecognised values fall through to the per-chain default, which is
  // `signatures` on mainnet - the opposite of what an operator typing
  // "getBlock" during an incident intends. Say so rather than silently
  // running the mode they were trying to leave.
  logger.warn(
    `[mapper] SOLANA_SOURCE_MODE="${process.env.SOLANA_SOURCE_MODE}" is not "signatures" or "getblock"; ignoring it and using the per-chain default`,
  );
  return undefined;
}

/**
 * Default ingestion strategy for a chain, from the chain's own shape.
 *
 * Event ingestion defaults to the server-side filtered `signatures` source:
 * `getBlock` pulls every produced block with full transaction detail, which is
 * a firehose (see specs/solana-event-ingestion.md) that no CPU request absorbs,
 * and which silently skips slots - and so misses triggers - once it falls
 * behind. This was gated on mainnet, on the assumption that a testnet produces
 * small blocks. KEEP-1242: that assumption is not the tracker's to make. Chain
 * 103's endpoint served Solana testnet, whose blocks are ~14x a devnet block,
 * and the testnet default spent 4x the prod CPU request to parse them.
 *
 * `undefined` means the `getblock` default, matching the factory. A chain with
 * no event triggers keeps it: `getBlock` runs header-only there, and it is the
 * only source that serves block triggers.
 */
function defaultSourceMode(hasEventTriggers: boolean): SourceMode | undefined {
  return hasEventTriggers ? "signatures" : undefined;
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

type PendingEvent = Omit<SolanaEventTrigger, "configHash">;
type PendingBlock = Omit<SolanaBlockTrigger, "configHash">;

interface PendingGroup {
  chainId: number;
  events: PendingEvent[];
  blocks: PendingBlock[];
}

/** Groups valid triggers by the key `keyOf` assigns; a null key leaves the workflow out. */
function groupTriggers<K>(
  data: DiscoveryData,
  keyOf: (workflow: RawWorkflow, chainId: number) => K | null,
  log: LogSink,
): Map<K, PendingGroup> {
  const groups = new Map<K, PendingGroup>();
  const groupFor = (key: K, chainId: number): PendingGroup => {
    const existing = groups.get(key);
    if (existing) {
      return existing;
    }
    const created: PendingGroup = { chainId, events: [], blocks: [] };
    groups.set(key, created);
    return created;
  };
  for (const wf of data.eventWorkflows) {
    const chainId = chainIdOf(wf);
    const key = chainId === null ? null : keyOf(wf, chainId);
    const trigger = key === null ? null : toEventTrigger(wf, log);
    if (chainId !== null && key !== null && trigger) {
      groupFor(key, chainId).events.push(trigger);
    }
  }
  for (const wf of data.blockWorkflows) {
    const chainId = chainIdOf(wf);
    const key = chainId === null ? null : keyOf(wf, chainId);
    const trigger = key === null ? null : toBlockTrigger(wf);
    if (chainId !== null && key !== null && trigger) {
      groupFor(key, chainId).blocks.push(trigger);
    }
  }
  return groups;
}

interface ResolvedTriggers {
  eventTriggers: SolanaEventTrigger[];
  blockTriggers: SolanaBlockTrigger[];
  sourceMode: SourceMode | undefined;
}

function resolveTriggers(
  group: PendingGroup,
  override: SourceMode | undefined,
): ResolvedTriggers {
  const eventTriggers: SolanaEventTrigger[] = group.events.map((t) => ({
    ...t,
    configHash: sha256(t),
  }));
  const blockTriggers: SolanaBlockTrigger[] = group.blocks.map((t) => ({
    ...t,
    configHash: sha256(t),
  }));
  return {
    eventTriggers,
    blockTriggers,
    sourceMode: override ?? defaultSourceMode(eventTriggers.length > 0),
  };
}

function registrationHash(
  endpoints: unknown,
  { eventTriggers, blockTriggers, sourceMode }: ResolvedTriggers,
): string {
  return sha256({
    endpoints,
    sourceMode: sourceMode ?? null,
    events: eventTriggers.map((t) => t.configHash).sort(),
    blocks: blockTriggers.map((t) => t.configHash).sort(),
  });
}

/**
 * Builds one ChainRegistration per Solana chain that has at least one valid
 * event or block trigger and resolvable endpoints. Malformed triggers and
 * chains missing RPC/WSS are skipped-and-logged, never thrown.
 */
export function buildRegistrations(data: DiscoveryData): ChainRegistration[] {
  const groups = groupTriggers(
    data,
    // A workflow with an organization route is never served on KeeperHub's endpoints.
    (wf, chainId) => (wf.rpcRoute == null ? chainId : null),
    logger,
  );
  const override = sourceModeOverride();
  const registrations: ChainRegistration[] = [];

  for (const [chainId, group] of groups) {
    const network = data.networks[chainId];
    const endpoints = resolveEndpoints(network, chainId);
    if (!endpoints || !network) {
      continue;
    }
    const triggers = resolveTriggers(group, override);
    registrations.push({
      chainId,
      isTestnet: network.isTestnet === true,
      ...endpoints,
      sourceMode: triggers.sourceMode,
      eventTriggers: triggers.eventTriggers,
      blockTriggers: triggers.blockTriggers,
      configHash: registrationHash(endpoints, triggers),
    });
  }

  return registrations;
}

/** One registration per organization route key; logs nothing. */
export function buildRouteRegistrations(
  data: DiscoveryData,
): RouteRegistration[] {
  const routes = new Map<string, RouteSpec>();
  const groups = groupTriggers(
    data,
    (wf, chainId) => {
      const route = parseRoute(wf.rpcRoute);
      if (!route || route.chainId !== chainId) {
        return null;
      }
      if (!routes.has(route.key)) {
        routes.set(route.key, route);
      }
      return route.key;
    },
    silentLogger,
  );
  const override = sourceModeOverride();
  const registrations: RouteRegistration[] = [];

  for (const [key, group] of groups) {
    const route = routes.get(key);
    const network = data.networks[group.chainId];
    if (!route || network?.chainType !== "solana") {
      continue;
    }
    const endpoints = {
      rpcUrl: route.primary.url,
      fallbackRpcUrl: route.fallback?.url,
      commitment: "confirmed" as const,
    };
    const triggers = resolveTriggers(group, override);
    registrations.push({
      chainId: group.chainId,
      isTestnet: network.isTestnet === true,
      ...endpoints,
      route,
      sourceMode: triggers.sourceMode,
      eventTriggers: triggers.eventTriggers,
      blockTriggers: triggers.blockTriggers,
      configHash: registrationHash({ ...endpoints, route }, triggers),
    });
  }

  return registrations;
}
