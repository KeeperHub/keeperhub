/**
 * Branch-aware final-success computation, extracted so unit tests can import
 * it without pulling the full executor module (which imports the plugin
 * registry and step-registry chain).
 */

import type { ExecutionErrorType } from "@/lib/errors/execution-error-type";

export type ExecutionResult = {
  success: boolean;
  data?: unknown;
  error?: string;
  /**
   * Authoritative error classification declared by the failing step (e.g. a
   * third-party dependency failure). Threaded to the run finalizer so it wins
   * over the message-string classifier.
   */
  errorClass?: ExecutionErrorType;
};

/**
 * A workflow succeeds iff every node in `results` succeeded OR was on a
 * not-taken condition branch (skipped).
 *
 * Extracted for post-drain re-evaluation (KEEP-395 Bug 2 hardening): drained
 * orphan-node failures land in `results` while drain awaits them; calling this
 * once after drain is the authoritative answer.
 */
export function computeFinalSuccess(
  results: Record<string, ExecutionResult>,
  skippedTargets: ReadonlySet<string>
): boolean {
  for (const [nodeId, r] of Object.entries(results)) {
    if (!(r.success || skippedTargets.has(nodeId))) {
      return false;
    }
  }
  return true;
}

export type OrphanedNodeScan = {
  /** Nodes whose whole upstream finished cleanly but which never ran. */
  attempted: ReadonlySet<string>;
  results: Record<string, ExecutionResult>;
  skipped: ReadonlySet<string>;
  edgesByTarget: ReadonlyMap<string, string[]>;
  conditionNodeIds: ReadonlySet<string>;
  /**
   * Nodes executed by a path other than the main traversal, so absence from
   * `attempted` proves nothing about them. For Each body nodes run through
   * runBodyNode and are accounted for by their For Each node's failedIterations.
   */
  excludedNodeIds?: ReadonlySet<string>;
};

/**
 * Find nodes that should have executed but were never scheduled.
 *
 * `computeFinalSuccess` only inspects `results`, so a node the executor never
 * reached cannot fail the run -- it is simply absent. That is invisible on a
 * fan-in join: every parallel branch succeeds, the join's arrival count comes
 * up short by one, the join and everything behind it never run, and the
 * execution still reports success. For an alerting workflow that means the
 * alert node silently never fires while the run shows green.
 *
 * A node is orphaned when it was never attempted, was not skipped by a
 * condition branch, and every one of its predecessors completed without
 * failing. If any predecessor failed, the node legitimately did not run and
 * the run already reports that failure.
 *
 * Nodes fed by a condition are excluded: whether they run is the condition's
 * routing decision, and on legacy edges that carry no sourceHandle the
 * not-taken branch leaves no skip record to distinguish from an orphan.
 */
export function findOrphanedNodes(scan: OrphanedNodeScan): string[] {
  const {
    attempted,
    results,
    skipped,
    edgesByTarget,
    conditionNodeIds,
    excludedNodeIds,
  } = scan;
  const orphaned: string[] = [];

  for (const [nodeId, predecessors] of edgesByTarget) {
    if (attempted.has(nodeId) || skipped.has(nodeId)) {
      continue;
    }
    if (excludedNodeIds?.has(nodeId)) {
      continue;
    }
    if (predecessors.length === 0) {
      continue;
    }
    if (predecessors.some((predId) => conditionNodeIds.has(predId))) {
      continue;
    }
    const upstreamClean = predecessors.every(
      (predId) =>
        attempted.has(predId) &&
        !skipped.has(predId) &&
        results[predId]?.success !== false
    );
    if (upstreamClean) {
      orphaned.push(nodeId);
    }
  }

  return orphaned.sort();
}
