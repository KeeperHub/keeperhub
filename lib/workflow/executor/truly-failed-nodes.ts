/**
 * Pure aggregation over workflow_execution_logs rows used by the workflow
 * finalization/self-heal reconciliation. Kept dependency-free (no db,
 * server-only) so the logic can be unit-tested directly.
 */

export type TrulyFailedLogRow = {
  nodeId: string;
  status: string;
  iterationIndex: number | null | undefined;
  forEachNodeId: string | null | undefined;
};

/**
 * Reduce a set of execution log rows to the node IDs that truly failed.
 *
 * Top-level steps are aggregated by `nodeId` (a node is OK if any of its rows
 * succeeded -- a cross-pod SDK retry can leave an orphan running/error row next
 * to the real success row).
 *
 * For Each iteration rows (`iterationIndex` + `forEachNodeId` non-null) are
 * aggregated per `(forEachNodeId, iterationIndex, nodeId)` so a failed iteration
 * body is NOT masked by a sibling iteration's success. When such a step has no
 * success row, its parent For Each node id is reported as failed. This is
 * required because `forEachStep` pre-logs the parent For Each node as success
 * before any iteration runs and never flips it; without counting iteration
 * failures here, a genuinely failed loop is invisible to every DB-based
 * reconciliation path and `logWorkflowCompleteDb` would override the real error
 * to success.
 *
 * Returns the (de-duplicated) list of node IDs -- top-level nodes and/or parent
 * For Each nodes -- that have at least one log row but no success row.
 */
export function computeTrulyFailedNodes(logs: TrulyFailedLogRow[]): string[] {
  const topLevelSucceeded = new Map<string, boolean>();
  const iterationSucceeded = new Map<string, boolean>();
  const iterationKeyToForEach = new Map<string, string>();

  for (const log of logs) {
    const { iterationIndex, forEachNodeId } = log;
    // A row is a For Each iteration row only when BOTH loop fields are present.
    // Drizzle returns null for top-level steps; guard for undefined too so a
    // row that simply omits the fields is not misread as an iteration row.
    const isIterationRow =
      iterationIndex !== null &&
      iterationIndex !== undefined &&
      forEachNodeId !== null &&
      forEachNodeId !== undefined;
    if (isIterationRow) {
      const key = `${forEachNodeId}:${iterationIndex}:${log.nodeId}`;
      iterationKeyToForEach.set(key, forEachNodeId);
      if (log.status === "success") {
        iterationSucceeded.set(key, true);
      } else if (!iterationSucceeded.has(key)) {
        iterationSucceeded.set(key, false);
      }
    } else if (log.status === "success") {
      topLevelSucceeded.set(log.nodeId, true);
    } else if (!topLevelSucceeded.has(log.nodeId)) {
      topLevelSucceeded.set(log.nodeId, false);
    }
  }

  const trulyFailedNodes = new Set<string>();
  for (const [nodeId, succeeded] of topLevelSucceeded) {
    if (!succeeded) {
      trulyFailedNodes.add(nodeId);
    }
  }
  for (const [key, succeeded] of iterationSucceeded) {
    if (!succeeded) {
      const forEachNodeId = iterationKeyToForEach.get(key);
      if (forEachNodeId) {
        trulyFailedNodes.add(forEachNodeId);
      }
    }
  }
  return [...trulyFailedNodes];
}
