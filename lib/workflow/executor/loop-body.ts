import type { EdgesBySourceHandle } from "@/lib/workflow/editor/edge-handle-utils";

/**
 * The loop-body walk, shared verbatim between the executor and the
 * fast-tier MCP workflow validator.
 *
 * This used to exist twice: the executor's real walk here, and a
 * hand-maintained approximation inside lib/mcp/validate-workflow.ts,
 * justified as "deliberately over-inclusive" for a warning that can afford
 * to be generous. It was not uniformly over-inclusive. A For Each whose
 * outgoing edge carries a non-`loop` sourceHandle (for example a condition
 * node's `"true"` handle feeding the loop body directly) makes the
 * executor's `isHandleAware` seed from every outgoing edge, so the body
 * runs the branch; the approximation's `legacyTargets` filtered on
 * `!sourceHandle` and excluded it, producing NO warning for a transfer the
 * executor genuinely runs once per iteration -- the exact double-pay shape
 * the warning exists to catch. It also warned on transfers reachable only
 * through a Collect node, which the executor never runs as loop body at
 * all.
 *
 * Only this module may define what a For Each's body is. Both callers
 * import it rather than each keeping their own opinion, so the two can
 * never diverge again. It has no imports beyond types (erased at compile
 * time), so importing it does not cost the fast-tier validator the heavy
 * dependencies the rest of executor.workflow.ts pulls in -- see that
 * file's own import list for what this avoids.
 */

/**
 * The minimal node shape this walk actually reads: which branch a node is
 * (`data.type`) and which action it configures (`data.config.actionType`).
 * Deliberately narrower than the executor's real node type (a React Flow
 * `Node`, defined in lib/workflow/store.ts) so the fast-tier MCP validator
 * can build this walk's inputs directly from plain, already-parsed workflow
 * JSON without pulling in `@xyflow/react`'s runtime node shape. The
 * executor's own `WorkflowNode` already satisfies this shape structurally,
 * so passing it in at the executor's call sites needs no cast.
 */
export type LoopBodyNode = {
  data: {
    type: string;
    config?: Record<string, unknown>;
  };
};

export type LoopBodyInfo = {
  bodyNodeIds: string[];
  /**
   * In-body Collect node found via depth-0 boundary BFS. Set in legacy graphs
   * (Collect placed in the body chain) and may also be set for transitional
   * graphs that have BOTH an in-body Collect and a done-handle Collect; in the
   * latter case the executor prefers `doneCollectNodeId`.
   */
  collectNodeId: string | undefined;
  /**
   * Entry points for the For Each's `done` sourceHandle. These run once after
   * the iteration loop completes (JS-equivalent: the line after `for (...) {}`).
   * Non-Collect targets execute as ordinary steps; a Collect target receives
   * the aggregated `{ results, count }` payload.
   */
  doneEntryNodeIds: string[];
  /**
   * If the canonical `done`-handle wiring routes to a Collect node, this is
   * its node ID. The executor prefers this over `collectNodeId` so workflows
   * that wire both are unambiguous.
   */
  doneCollectNodeId: string | undefined;
  bodyEdgesBySource: Map<string, string[]>;
  bodyEdgesBySourceHandle: EdgesBySourceHandle;
};

/**
 * Compute the next BFS depth when traversing loop body nodes.
 * Inner For Each increments depth, inner Collect decrements it.
 */
export function computeNextDepth(
  isForEach: boolean,
  isCollect: boolean,
  currentDepth: number
): number {
  if (isForEach) {
    return currentDepth + 1;
  }
  if (isCollect) {
    return currentDepth - 1;
  }
  return currentDepth;
}

/**
 * Pick the next-target list for a node visited inside a For Each body BFS.
 *
 * For nested For Each nodes that themselves expose `loop`/`done` handles, the
 * outer body resumes at the inner `done` chain (the inner loop body is the
 * inner For Each's own concern, not the outer's). For every other node — and
 * for legacy nested For Each nodes with no sourceHandle on their outgoing
 * edges — fall through to the handle-agnostic `edgesBySource` map; the depth
 * counter handles the legacy in-body Collect boundary case.
 */
export function nextBodyTargets(
  nodeId: string,
  isForEach: boolean,
  edgesBySource: Map<string, string[]>,
  edgesBySourceHandle: EdgesBySourceHandle | undefined
): string[] {
  if (isForEach) {
    const handles = edgesBySourceHandle?.get(nodeId);
    const loopTargets = handles?.get("loop") ?? [];
    const doneTargets = handles?.get("done") ?? [];
    if (loopTargets.length > 0 || doneTargets.length > 0) {
      return doneTargets;
    }
  }
  return edgesBySource.get(nodeId) ?? [];
}

export function collectOwnershipConflictMessage(
  collectNodeId: string,
  forEachId: string,
  claimedBy: string
): string {
  return (
    `For Each "${forEachId}" resolves Collect "${collectNodeId}", but it ` +
    `already belongs to For Each "${claimedBy}". Two For Each loops ` +
    "cannot share the same Collect node."
  );
}

/**
 * Identify the loop body subgraph between a For Each node and its paired
 * Collect node.
 *
 * Two modes:
 *
 * 1. **Handle-aware** (canonical): the For Each has at least one outgoing
 *    edge with a `loop` or `done` sourceHandle. Body BFS seeds from the
 *    `loop` targets only; `done` targets become `doneEntryNodeIds` and run
 *    once the iteration loop finishes. If the first done target is a Collect
 *    node, it is recorded as `doneCollectNodeId` (the executor will hand it
 *    the aggregated `{ results, count }` payload).
 *
 * 2. **Legacy**: the For Each has no sourceHandle on any outgoing edge. Body
 *    BFS seeds from every outgoing edge (current pre-handle behavior) and
 *    terminates at the first depth-0 Collect, which becomes `collectNodeId`.
 *
 * In both modes the BFS uses depth tracking so nested For Each / Collect
 * pairs are correctly stepped over.
 *
 * `claimedCollectOwners`, when supplied, maps a Collect node id to the
 * forEachNodeId that already resolved it as its own. If this scan's depth-0
 * Collect is claimed by a *different* loop, it throws immediately naming
 * both loops (#2157) instead of either colliding with a same-scan double
 * Collect (below) or silently adopting the other loop's Collect as its own.
 * Callers that omit the map get today's unqualified behavior unchanged.
 */
export function identifyLoopBody(
  forEachNodeId: string,
  edgesBySource: Map<string, string[]>,
  nodeMap: Map<string, LoopBodyNode>,
  edgesBySourceHandle?: EdgesBySourceHandle,
  claimedCollectOwners?: Map<string, string>
): LoopBodyInfo {
  const bodyNodeIds: string[] = [];
  const bodyEdgesBySource = new Map<string, string[]>();
  const bodyEdgesBySourceHandle: EdgesBySourceHandle = new Map();
  let collectNodeId: string | undefined;
  const visited = new Set<string>();

  // Determine seeding strategy. Handle-aware mode kicks in as soon as any
  // outgoing edge from this For Each carries a sourceHandle, so a workflow
  // can opt in incrementally without changing legacy edges elsewhere.
  const handleMap = edgesBySourceHandle?.get(forEachNodeId);
  const loopTargets = handleMap?.get("loop") ?? [];
  const doneTargets = handleMap?.get("done") ?? [];
  const isHandleAware = loopTargets.length > 0 || doneTargets.length > 0;
  const seedTargets = isHandleAware
    ? loopTargets
    : (edgesBySource.get(forEachNodeId) ?? []);

  for (const targetId of seedTargets) {
    if (!bodyEdgesBySource.has(forEachNodeId)) {
      bodyEdgesBySource.set(forEachNodeId, []);
    }
    bodyEdgesBySource.get(forEachNodeId)?.push(targetId);
  }

  const queue: Array<{ nodeId: string; depth: number }> = seedTargets.map(
    (id) => ({ nodeId: id, depth: 0 })
  );

  while (queue.length > 0) {
    const entry = queue.shift();
    if (!entry) {
      break;
    }
    const { nodeId, depth } = entry;

    if (visited.has(nodeId)) {
      continue;
    }
    visited.add(nodeId);

    const node = nodeMap.get(nodeId);
    if (!node) {
      continue;
    }

    const actionType = node.data.config?.actionType as string | undefined;
    const isCollect = node.data.type === "action" && actionType === "Collect";
    const isForEach = node.data.type === "action" && actionType === "For Each";

    // Collect at depth 0 is the legacy in-body boundary. In handle-aware
    // graphs this still terminates the body BFS; the executor decides at
    // post-iteration time whether to fire the in-body Collect (legacy) or
    // the done-handle Collect (canonical).
    if (isCollect && depth === 0) {
      const claimedBy = claimedCollectOwners?.get(nodeId);
      if (claimedBy && claimedBy !== forEachNodeId) {
        throw new Error(
          collectOwnershipConflictMessage(nodeId, forEachNodeId, claimedBy)
        );
      }
      if (collectNodeId && collectNodeId !== nodeId) {
        throw new Error(
          "For Each node has multiple in-body Collect nodes at the same " +
            "nesting level. Wire the Collect to the For Each's `done` " +
            "sourceHandle (canonical) or keep exactly one in-body Collect."
        );
      }
      collectNodeId = nodeId;
      continue;
    }

    bodyNodeIds.push(nodeId);

    const nextDepth = computeNextDepth(isForEach, isCollect, depth);
    const nextIds = nextBodyTargets(
      nodeId,
      isForEach,
      edgesBySource,
      edgesBySourceHandle
    );
    for (const nextId of nextIds) {
      if (!bodyEdgesBySource.has(nodeId)) {
        bodyEdgesBySource.set(nodeId, []);
      }
      bodyEdgesBySource.get(nodeId)?.push(nextId);
      queue.push({ nodeId: nextId, depth: nextDepth });
    }
  }

  // Copy handle-aware edges, filtering targets to body-only nodes so
  // condition handles cannot accidentally route outside the loop body.
  const bodyNodeSet = new Set(bodyNodeIds);
  for (const bodyNodeId of bodyNodeIds) {
    const nodeHandleMap = edgesBySourceHandle?.get(bodyNodeId);
    if (!nodeHandleMap) {
      continue;
    }
    const filteredHandleMap = new Map<string, string[]>();
    for (const [handle, targets] of nodeHandleMap) {
      const filteredTargets = targets.filter((t) => bodyNodeSet.has(t));
      if (filteredTargets.length > 0) {
        filteredHandleMap.set(handle, filteredTargets);
      }
    }
    if (filteredHandleMap.size > 0) {
      bodyEdgesBySourceHandle.set(bodyNodeId, filteredHandleMap);
    }
  }

  // Resolve the canonical post-loop Collect: the first `done`-handle target
  // whose actionType is Collect. Non-Collect done targets remain in
  // `doneEntryNodeIds` and run as ordinary steps after the iteration loop.
  let doneCollectNodeId: string | undefined;
  for (const targetId of doneTargets) {
    const target = nodeMap.get(targetId);
    if (
      target?.data.type === "action" &&
      target.data.config?.actionType === "Collect"
    ) {
      doneCollectNodeId = targetId;
      break;
    }
  }

  return {
    bodyNodeIds,
    collectNodeId,
    doneEntryNodeIds: doneTargets,
    doneCollectNodeId,
    bodyEdgesBySource,
    bodyEdgesBySourceHandle,
  };
}
