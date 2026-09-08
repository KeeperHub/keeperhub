/**
 * Pure convergence barrier logic for fork-join synchronization in
 * workflow execution. Extracted so the algorithms can be tested
 * directly without mocking the full executor.
 */

type EdgeLike = {
  source: string;
  target: string;
};

/** Build reverse edge map: target node ID -> source node IDs. */
export function buildEdgesByTarget(edges: EdgeLike[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const edge of edges) {
    const sources = map.get(edge.target) ?? [];
    if (!sources.includes(edge.source)) {
      sources.push(edge.source);
    }
    map.set(edge.target, sources);
  }
  return map;
}

/** Build forward edge map: source node ID -> target node IDs. */
export function buildEdgesBySource(edges: EdgeLike[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const edge of edges) {
    const targets = map.get(edge.source) ?? [];
    if (!targets.includes(edge.target)) {
      targets.push(edge.target);
    }
    map.set(edge.source, targets);
  }
  return map;
}

/**
 * Record one arrival edge into a convergence node. Real arrivals land in
 * `convergenceArrivals`; skip arrivals land in both maps so the skip count can
 * be compared against the in-degree to detect an all-skipped join.
 */
function recordArrival(
  nodeId: string,
  fromSource: string,
  isSkip: boolean,
  convergenceArrivals: Map<string, Set<string>>,
  convergenceSkipArrivals: Map<string, Set<string>>
): void {
  let arrivals = convergenceArrivals.get(nodeId);
  if (arrivals === undefined) {
    arrivals = new Set<string>();
    convergenceArrivals.set(nodeId, arrivals);
  }
  arrivals.add(fromSource);

  if (!isSkip) {
    return;
  }
  let skipArrivals = convergenceSkipArrivals.get(nodeId);
  if (skipArrivals === undefined) {
    skipArrivals = new Set<string>();
    convergenceSkipArrivals.set(nodeId, skipArrivals);
  }
  skipArrivals.add(fromSource);
}

/**
 * Signal arrival at convergence nodes (nodes with >1 incoming edge) and
 * return the IDs of any that became fully unblocked. Non-convergence nodes
 * in targetNodeIds are ignored.
 */
export function signalConvergenceArrival(
  fromNodeId: string,
  targetNodeIds: string[],
  edgesByTarget: Map<string, string[]>,
  convergenceArrivals: Map<string, Set<string>>,
  visited: Set<string>
): string[] {
  const unblocked: string[] = [];
  for (const nextId of targetNodeIds) {
    const incomingSources = edgesByTarget.get(nextId);
    if (incomingSources === undefined || incomingSources.length <= 1) {
      continue;
    }
    let arrivals = convergenceArrivals.get(nextId);
    if (arrivals === undefined) {
      arrivals = new Set<string>();
      convergenceArrivals.set(nextId, arrivals);
    }
    arrivals.add(fromNodeId);
    if (arrivals.size >= incomingSources.length && !visited.has(nextId)) {
      unblocked.push(nextId);
    }
  }
  return unblocked;
}

/**
 * Determine which downstream nodes are ready to execute, applying
 * convergence barriers for nodes with multiple incoming edges.
 * Non-convergence nodes pass through immediately.
 */
export function getReadyDownstreamIds(
  fromNodeId: string,
  nextNodeIds: string[],
  edgesByTarget: Map<string, string[]>,
  convergenceArrivals: Map<string, Set<string>>,
  visited: Set<string>
): string[] {
  const readyIds: string[] = [];

  for (const nextId of nextNodeIds) {
    const incomingSources = edgesByTarget.get(nextId);
    const isConvergenceNode =
      incomingSources !== undefined && incomingSources.length > 1;

    if (!isConvergenceNode) {
      readyIds.push(nextId);
    }
  }

  readyIds.push(
    ...signalConvergenceArrival(
      fromNodeId,
      nextNodeIds,
      edgesByTarget,
      convergenceArrivals,
      visited
    )
  );

  return readyIds;
}

/**
 * Propagate skip signals from a condition's not-taken branch.
 *
 * Records a skip-arrival at every convergence node reached through the
 * not-taken subtree (kept apart from real arrivals in `convergenceSkipArrivals`)
 * and BFS-walks through fully-skipped nodes. A convergence node is released to
 * EXECUTE only once every incoming edge has arrived AND at least one of those
 * arrivals was a real (executed) node. When every incoming edge is a skip the
 * node is itself skipped: it is added to `skippedNodes` and the skip continues
 * to its downstream. This is what stops an OR-join (e.g. an alert step wired to
 * the `false` handle of several conditions) from firing when every condition
 * took its other branch.
 *
 * `skipFromId` is the node initiating the skip (the condition); it is the
 * arrival source recorded at each direct not-taken target. Returns the
 * convergence node IDs that became ready to execute (caller runs them).
 */
export function propagateConvergenceSkips(
  skipFromId: string,
  skippedNodeIds: string[],
  edgesBySource: Map<string, string[]>,
  edgesByTarget: Map<string, string[]>,
  convergenceArrivals: Map<string, Set<string>>,
  convergenceSkipArrivals: Map<string, Set<string>>,
  skippedNodes: Set<string>,
  visited: Set<string>
): string[] {
  const executeReady: string[] = [];
  const queue: Array<{ id: string; from: string }> = skippedNodeIds.map(
    (id) => ({ id, from: skipFromId })
  );
  const propagated = new Set<string>();

  const continueSkip = (id: string): void => {
    skippedNodes.add(id);
    if (propagated.has(id)) {
      return;
    }
    propagated.add(id);
    for (const downId of edgesBySource.get(id) ?? []) {
      queue.push({ id: downId, from: id });
    }
  };

  while (queue.length > 0) {
    const { id, from } = queue.shift() as { id: string; from: string };
    const incomingSources = edgesByTarget.get(id);
    const isConvergenceNode =
      incomingSources !== undefined && incomingSources.length > 1;

    if (!isConvergenceNode) {
      // Non-convergence node: the skip flows straight through it.
      continueSkip(id);
      continue;
    }

    recordArrival(id, from, true, convergenceArrivals, convergenceSkipArrivals);

    if ((convergenceArrivals.get(id)?.size ?? 0) < incomingSources.length) {
      // Still awaiting arrivals from the real-execution path; stop here.
      continue;
    }

    if (
      (convergenceSkipArrivals.get(id)?.size ?? 0) >= incomingSources.length
    ) {
      // Every incoming edge was skipped: skip this node and keep walking.
      continueSkip(id);
    } else if (!visited.has(id)) {
      // At least one arrival came from a real execution: the node runs.
      executeReady.push(id);
    }
  }

  return executeReady;
}
