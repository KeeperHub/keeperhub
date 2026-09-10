import { SQS_QUEUE_URL } from "../lib/config/environment";
import * as metrics from "../lib/metrics";
import { sqs } from "../lib/sqs-client";
import { logger } from "../lib/utils/logger";
import type { DedupStore } from "./dedup";
import { createRedisDedupStore } from "./dedup-redis";
import { fetchSolanaTriggers } from "./discovery";
import { BlockIngestor } from "./ingest/block-ingestor";
import { disconnectedHealth } from "./ingest/block-source";
import type { ConnectionHealth } from "./ingest/solana-connection";
import { buildRegistrations } from "./mapper";
import { type ChainRegistration, registrationEndpoints } from "./registrations";

/**
 * Reconciler: one BlockIngestor per Solana chain, keyed by chainId. Mirrors the
 * block-dispatcher's converge loop - remove stale chains, add new ones, and on
 * a config change either refresh the trigger set in place or restart the
 * ingestor, depending on whether the change reaches inputs the running
 * BlockSource baked in at construction (see `canUpdateInPlace`).
 */

const registry = new Map<number, BlockIngestor>();

/**
 * Every chain discovery says we should be ingesting, whether or not it has a
 * running ingestor. Health is reported per *expected* chain, not per running
 * one: the registry alone cannot tell "no Solana workflows exist", which is
 * healthy, from "five chains were expected and all five died", which is not.
 * Both used to produce an empty list and a 200.
 */
const desired = new Map<number, ChainRegistration>();

/** Why a desired chain has no running ingestor. Cleared when it recovers. */
const failures = new Map<number, string>();

const processStartedAt = Date.now();
let lastSyncStartedAt: number | null = null;
let lastSyncCompletedAt: number | null = null;

export interface LivenessSnapshot {
  processStartedAt: number;
  lastSyncStartedAt: number | null;
  lastSyncCompletedAt: number | null;
}

export function getLiveness(): LivenessSnapshot {
  return { processStartedAt, lastSyncStartedAt, lastSyncCompletedAt };
}

/**
 * Drop a chain's ingestor and every metric series it owns. A gauge left behind
 * keeps climbing and holds an alert open forever on a chain nobody watches.
 */
function dropChain(chainId: number): void {
  registry.delete(chainId);
  metrics.forgetChain(chainId);
}

// Lazy: constructing the dedup store opens a Redis connection. Defer until the
// first reconcile so unit tests importing this module do not connect.
let dedup: DedupStore | null = null;
function getDedup(): DedupStore {
  if (!dedup) {
    dedup = createRedisDedupStore();
  }
  return dedup;
}

async function startIngestor(registration: ChainRegistration): Promise<void> {
  const ingestor = new BlockIngestor({
    registration,
    sqs,
    sqsQueueUrl: SQS_QUEUE_URL,
    dedup: getDedup(),
  });
  await ingestor.start();
  registry.set(registration.chainId, ingestor);
}

async function reconcile(registrations: ChainRegistration[]): Promise<void> {
  const activeIds = new Set(registrations.map((r) => r.chainId));

  // Rebuilt before the start loop so a throw partway through still leaves the
  // reported health honest about what was supposed to be running.
  desired.clear();
  for (const registration of registrations) {
    desired.set(registration.chainId, registration);
  }
  for (const chainId of [...failures.keys()]) {
    if (!desired.has(chainId)) {
      failures.delete(chainId);
    }
  }

  for (const [chainId, ingestor] of registry) {
    if (!activeIds.has(chainId)) {
      logger.log(`[Reconciler] removing ingestor for chain ${chainId}`);
      await ingestor.stop();
      dropChain(chainId);
    }
  }

  for (const registration of registrations) {
    const existing = registry.get(registration.chainId);
    try {
      if (!existing) {
        await startIngestor(registration);
      } else if (existing.hasConfigChanged(registration)) {
        if (existing.canUpdateInPlace(registration)) {
          existing.updateRegistration(registration);
        } else {
          logger.log(
            `[Reconciler] chain ${registration.chainId} source inputs changed; restarting`,
          );
          await existing.stop();
          dropChain(registration.chainId);
          await startIngestor(registration);
        }
      }
      failures.delete(registration.chainId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(
        `[Reconciler] chain ${registration.chainId} failed: ${message}`,
      );
      // Recorded, not forgotten. Deleting the chain here used to make it vanish
      // from /healthz entirely, so a chain that could not start read as healthy.
      failures.set(registration.chainId, message);
      // Only drop an ingestor that is genuinely not running. A throw out of
      // stop() in the restart branch above would otherwise delete a live
      // ingestor and orphan its connection, watchdog and socket for good.
      const orphan = registry.get(registration.chainId);
      if (orphan && !orphan.isStarted()) {
        dropChain(registration.chainId);
      }
    }
  }

  logger.log(
    `[Reconciler] pass complete: ${registry.size}/${desired.size} chains active`,
  );
}

export async function synchronizeData(): Promise<void> {
  // Stamped here, at the top, and on every exit path below. This is the
  // liveness signal, and it must mean "the interval fired and the event loop
  // ran", not "a pass succeeded". Discovery uses fetch with no AbortSignal and
  // web3.js sets no request timeout, so a hung upstream can pin this function
  // indefinitely while the process is perfectly healthy - keying liveness off
  // completion would restart the pod for someone else's outage, which is the
  // exact failure this work exists to remove.
  lastSyncStartedAt = Date.now();
  logger.log("Synchronizing data");
  try {
    const data = await fetchSolanaTriggers();
    if (!data) {
      logger.warn("No discovery data received; skipping sync cycle");
      return;
    }
    const registrations = buildRegistrations(data);
    logger.log(
      `Found ${data.eventWorkflows.length} event + ${data.blockWorkflows.length} block workflows -> ${registrations.length} Solana chains`,
    );
    await reconcile(registrations);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Error during synchronization: ${message}`);
  } finally {
    // Observability only - never a liveness input, for the reason above.
    lastSyncCompletedAt = Date.now();
  }
}

export async function shutdownAll(): Promise<void> {
  for (const ingestor of registry.values()) {
    await ingestor.stop();
  }
  registry.clear();
  desired.clear();
  failures.clear();
  if (dedup) {
    await dedup.disconnect();
  }
}

/**
 * One entry per chain discovery expects, not per chain that happens to be
 * running. A chain that failed to start, or whose source has not come up yet,
 * reports as disconnected instead of disappearing - so an empty list now means
 * "nothing is configured", which is genuinely healthy, and five dead chains
 * produce five disconnected entries and a 503.
 */
export function getAllHealth(): ConnectionHealth[] {
  const health: ConnectionHealth[] = [];
  for (const [chainId, registration] of desired) {
    const live = registry.get(chainId)?.getHealth();
    health.push(
      live ??
        disconnectedHealth(
          chainId,
          registration.sourceMode ?? "getblock",
          registrationEndpoints(registration),
          failures.get(chainId) ?? "not started",
        ),
    );
  }
  return health;
}

/**
 * Refresh the metric series from the current health snapshot. Called at scrape
 * time so nothing in the ingest path has to know metrics exist.
 */
export function refreshMetrics(): void {
  for (const health of getAllHealth()) {
    metrics.recordChainHealth(
      health,
      desired.get(health.chainId)?.isTestnet ?? false,
    );
  }
}
