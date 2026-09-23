import type { NetworksMap, RawWorkflow } from "../lib/types";
import { fetchActiveWorkflows } from "../lib/utils/fetch-utils";
import { logger } from "../lib/utils/logger";
import { chainProviderManager } from "./chains/provider-manager";
import { forgetTraceRefusalsFor } from "./chains/trace-capability";
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

/**
 * Workflows whose invalid-config skip has already been logged.
 *
 * `buildRegistration` returns null for several reasons (bad chain, missing
 * fields, unsupported trigger) and the reconciler is not told which, so this
 * latches on the workflow id alone: log the skip once, then stay quiet while
 * the workflow keeps failing to build. `synchronizeData` reconciles every 30
 * seconds and re-maps every workflow, so without the latch the skip line
 * repeats once per refused workflow every 30 seconds for the life of the pod.
 * That outlives and buries the capability warn in `workflow-mapper.ts` that
 * names the chain and the allowed set, which is itself latched. This gives the
 * generic line the same treatment, so both fire once per transition and go
 * quiet together, and both stay in the same log window rather than one
 * surviving rotation while the useful one is gone.
 *
 * A transition latch, not a permanent gag. Cleared when the workflow later
 * builds a registration (a config that becomes valid and then invalid again is
 * reported the second time) and when the workflow leaves the active set
 * (re-adding an invalid one is reported again).
 *
 * The mapper's latch clears on both of the same triggers, which is what keeps
 * the pair in step: `forgetTraceRefusal` on a successful map, and
 * `forgetTraceRefusalsFor` from the prune loop below when the workflow leaves
 * the active set. Clearing on only one of the two is what used to let a
 * disable-then-enable report this generic line with the chain-naming one still
 * latched.
 */
const reportedSkips = new Set<string>();

/** Whether this skip is new. True once per workflow, then false until cleared. */
function shouldReportSkip(workflowId: string): boolean {
  if (reportedSkips.has(workflowId)) {
    return false;
  }
  reportedSkips.add(workflowId);
  return true;
}

/**
 * Drop the reconciler skip latch. Tests only, so a case asserting the skip
 * line is emitted once starts from a defined state rather than inheriting a
 * latch set by an earlier case in the same process.
 */
function resetReconcilerSkipLatch(): void {
  reportedSkips.clear();
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

  // Drop skip-latch entries for workflows that left the active set, so
  // re-adding an invalid one is reported again. Mirrors the remove loop below
  // dropping their listeners.
  //
  // The mapper's own refusal latch is pruned on the same trigger. Both lines
  // describe one refusal and only one of them names the chain and the allowed
  // set, so clearing them on different triggers meant a disable-then-enable
  // reported the generic line without the useful one.
  for (const id of [...reportedSkips]) {
    if (!activeIds.has(id)) {
      reportedSkips.delete(id);
      forgetTraceRefusalsFor(id);
    }
  }

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
        // Latched per workflow so a steady refusal is one line at the
        // transition, not one every reconcile pass: the capability warn in
        // workflow-mapper.ts that names the chain gate is latched too, and an
        // unlatched line here repeats past rotation and buries it.
        if (shouldReportSkip(workflowId)) {
          logger.warn(
            `[Reconciler] skipping workflow ${workflowId}: buildRegistration returned null (invalid config)`,
          );
        }
        skippedInvalid++;
        continue;
      }
      // Valid config now, so a later skip for this workflow is a new fact.
      reportedSkips.delete(workflowId);
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

export {
  getRegistry,
  reconcile,
  resetReconcilerSkipLatch,
  shutdownRegistry,
  synchronizeData,
};
