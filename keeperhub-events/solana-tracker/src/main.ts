import { SQS_QUEUE_URL } from "../lib/config/environment";
import { sqs } from "../lib/sqs-client";
import { logger } from "../lib/utils/logger";
import type { DedupStore } from "./dedup";
import { createRedisDedupStore } from "./dedup-redis";
import { fetchSolanaTriggers } from "./discovery";
import { BlockIngestor } from "./ingest/block-ingestor";
import type { ConnectionHealth } from "./ingest/solana-connection";
import { buildRegistrations } from "./mapper";
import type { ChainRegistration } from "./registrations";

/**
 * Reconciler: one BlockIngestor per Solana chain, keyed by chainId. Mirrors the
 * block-dispatcher's converge loop - remove stale chains, add new ones, and on
 * a config change either refresh the trigger set in place or restart the
 * ingestor, depending on whether the change reaches inputs the running
 * BlockSource baked in at construction (see `canUpdateInPlace`).
 */

const registry = new Map<number, BlockIngestor>();

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

  for (const [chainId, ingestor] of registry) {
    if (!activeIds.has(chainId)) {
      logger.log(`[Reconciler] removing ingestor for chain ${chainId}`);
      await ingestor.stop();
      registry.delete(chainId);
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
          registry.delete(registration.chainId);
          await startIngestor(registration);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(
        `[Reconciler] chain ${registration.chainId} failed: ${message}`,
      );
      registry.delete(registration.chainId);
    }
  }

  logger.log(`[Reconciler] pass complete: ${registry.size} chains active`);
}

export async function synchronizeData(): Promise<void> {
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
  }
}

export async function shutdownAll(): Promise<void> {
  for (const ingestor of registry.values()) {
    await ingestor.stop();
  }
  registry.clear();
  if (dedup) {
    await dedup.disconnect();
  }
}

export function getAllHealth(): ConnectionHealth[] {
  const health: ConnectionHealth[] = [];
  for (const ingestor of registry.values()) {
    const h = ingestor.getHealth();
    if (h) {
      health.push(h);
    }
  }
  return health;
}
