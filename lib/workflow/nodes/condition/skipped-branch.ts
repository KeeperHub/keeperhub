/**
 * Utilities for tracking condition routing decisions and identifying
 * nodes on dead (not-taken) branches during workflow execution.
 */

import type { EdgesBySourceHandle } from "@/lib/workflow/editor/edge-handle-utils";

export type ConditionDecision = {
  taken: string;
  skippedTargets: string[];
  /** Target node IDs on the handle that was taken (these nodes execute). */
  takenTargets?: string[];
};

/**
 * Given a condition node and the handle that was NOT taken,
 * return the direct target node IDs on that handle.
 */
export function collectSkippedTargets(
  conditionNodeId: string,
  notTakenHandle: string,
  edgesBySourceHandle: EdgesBySourceHandle
): string[] {
  const handleMap = edgesBySourceHandle.get(conditionNodeId);
  if (!handleMap) {
    return [];
  }
  return handleMap.get(notTakenHandle) ?? [];
}

/**
 * Aggregate not-taken targets across all condition decisions, excluding any
 * node that another condition actually took (executed), so its failure is not
 * masked as skipped.
 */
export function collectAllSkippedTargets(
  conditionDecisions: Map<string, ConditionDecision>
): Set<string> {
  const allSkipped = new Set<string>();
  const allTaken = new Set<string>();
  for (const decision of conditionDecisions.values()) {
    for (const target of decision.skippedTargets) {
      allSkipped.add(target);
    }
    for (const target of decision.takenTargets ?? []) {
      allTaken.add(target);
    }
  }
  for (const target of allTaken) {
    allSkipped.delete(target);
  }
  return allSkipped;
}
