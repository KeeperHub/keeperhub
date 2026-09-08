import type { NetworksMap, RawWorkflow } from "../lib/types";
import { fetchActiveWorkflows } from "../lib/utils/fetch-utils";
import { logger } from "../lib/utils/logger";
import { chainProviderManager } from "./chains/provider-manager";
import { createRegistry } from "./listener/factory";
import type { ListenerRegistry } from "./listener/registry";
import { buildRegistration } from "./listener/workflow-mapper";

// Lazy: creating the registry opens a Redis connection for dedup. Defer
// construction until the first reconcile so unit tests that import this
// module without env wiring do not connect on import.
let registry: ListenerRegistry | null = null;

function getRegistry(): ListenerRegistry {
  if (!registry) {
    registry = createRegistry();
  }
  return registry;
}

/**
 * Stops every listener if the registry was constructed, then tears down the
 * shared provider manager. Kept separate from `getRegistry` so shutdown does
 * not lazily construct a registry just to tear it down - that would open a
 * Redis connection for no reason.
 *
 * `stopAll` unsubscribes every listener, which detaches block listeners and
 * heartbeats, but the manager also owns providers and a manager-wide stats
 * interval that only `destroy` clears. Without this call nothing in `src`
 * ever invoked it, so those outlived the listeners they existed for.
 */
async function shutdownRegistry(): Promise<void> {
  if (registry) {
    await registry.stopAll();
  }
  await chainProviderManager.destroy();
}

async function reconcile(
  workflows: RawWorkflow[],
  networks: NetworksMap,
): Promise<void> {
  const reg = getRegistry();

  const activeIds = new Set<string>(
    workflows
      .map((w) => w.id)
      .filter((id): id is string => typeof id === "string"),
  );

  let removed = 0;
  let addAttempted = 0;
  let skippedInvalid = 0;
  let failed = 0;

  // Remove listeners for workflows that are no longer active.
  for (const id of reg.ids()) {
    if (!activeIds.has(id)) {
      logger.log(`[Reconciler] removing listener ${id} (no longer active)`);
      reg.remove(id);
      removed++;
    }
  }

  // Add listeners for active workflows that are not yet registered, and
  // restart listeners whose config has changed since last reconcile.
  for (const workflow of workflows) {
    const workflowId =
      typeof workflow.id === "string" ? workflow.id : "<unknown>";
    try {
      const registration = buildRegistration(workflow, networks);
      if (!registration) {
        // Operator-visible signal that a workflow was dropped from the
        // active set due to invalid config (bad chain, missing fields,
        // unsupported trigger). Without this log, operators see the
        // workflow in the source-of-truth but no listener and no hint why.
        logger.warn(
          `[Reconciler] skipping workflow ${workflowId}: buildRegistration returned null (invalid config)`,
        );
        skippedInvalid++;
        continue;
      }
      const existingHash = reg.getConfigHash(registration.workflowId);
      if (existingHash === registration.configHash) {
        // Listener already running with the same config; nothing to do.
        continue;
      }
      if (existingHash !== undefined) {
        logger.log(
          `[Reconciler] config changed for ${registration.workflowId}; restarting listener`,
        );
        reg.remove(registration.workflowId);
      }
      await reg.add(registration);
      addAttempted++;
    } catch (err) {
      // Per-workflow isolation: one poisoned workflow's exception must
      // not abort the whole reconcile pass. The synchronizeData catch
      // sees a generic message; this catch records which workflow
      // tripped so the next log line points at the culprit.
      const message = err instanceof Error ? err.message : String(err);
      logger.error(
        `[Reconciler] workflow ${workflowId} failed during reconcile: ${message}`,
      );
      failed++;
    }
  }

  logger.log(
    `[Reconciler] pass complete: ${workflows.length} active, +${addAttempted} add-attempted, -${removed} removed, !${skippedInvalid} invalid, !!${failed} failed`,
  );
}

async function synchronizeData(): Promise<void> {
  logger.log("Synchronizing data");
  try {
    const result = await fetchActiveWorkflows();
    if (!result) {
      logger.warn("No data received from worker, skipping sync cycle");
      return;
    }
    const { workflows, networks } = result;

    logger.log(`Found ${workflows.length} workflows`);
    logger.log(`Found ${Object.keys(networks).length} networks`);
    if (!Array.isArray(workflows)) {
      throw new Error(
        "Invalid data received from database. Expected an array.",
      );
    }

    await reconcile(workflows, networks);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Error during synchronization: ${message}`);
  }
}

export { getRegistry, shutdownRegistry, synchronizeData };
