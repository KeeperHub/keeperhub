/**
 * Back-edge classification for workflow graphs.
 *
 * A workflow is authored as a DAG plus, optionally, edges that point back at an
 * ancestor so a branch can run an earlier part of the graph again. Those back
 * edges are the loop primitive. Everything else in the engine (convergence
 * barriers, orphan detection, For Each body identification, auto-layout column
 * assignment) reasons over the forward DAG and must not see them: a node whose
 * only extra predecessor is the back edge would otherwise wait for an arrival
 * that cannot happen until after it has run, and the branch stalls there.
 *
 * An edge u -> v is a back edge when v is still on the depth-first stack while u
 * is being explored. Removing every classified back edge always leaves an
 * acyclic graph. Nodes with no incoming edge are visited first so the trigger
 * side anchors the traversal and the edge classified is the one the author drew
 * backwards, not an arbitrary member of the cycle.
 */

export type BackEdgeNode = {
  id: string;
};

export type BackEdgeLike = {
  source: string;
  target: string;
};

/** Source node ID -> the loop-entry nodes its back edges point at. */
export type BackEdgesBySource = ReadonlyMap<string, ReadonlySet<string>>;

const UNVISITED = 0;
const ON_STACK = 1;
const EXPLORED = 2;

function buildOutgoing<E extends BackEdgeLike>(edges: E[]): Map<string, E[]> {
  const outgoing = new Map<string, E[]>();
  for (const edge of edges) {
    const existing = outgoing.get(edge.source);
    if (existing) {
      existing.push(edge);
    } else {
      outgoing.set(edge.source, [edge]);
    }
  }
  return outgoing;
}

/**
 * Order the DFS roots: nodes with no incoming edge first (in declaration
 * order), then every remaining node so a cycle unreachable from any root is
 * still classified.
 */
function startOrder(nodes: BackEdgeNode[], edges: BackEdgeLike[]): string[] {
  const hasIncoming = new Set<string>();
  for (const edge of edges) {
    hasIncoming.add(edge.target);
  }
  const roots: string[] = [];
  const rest: string[] = [];
  for (const node of nodes) {
    if (hasIncoming.has(node.id)) {
      rest.push(node.id);
    } else {
      roots.push(node.id);
    }
  }
  return [...roots, ...rest];
}

function record(
  map: Map<string, Set<string>>,
  source: string,
  target: string
): void {
  const targets = map.get(source);
  if (targets) {
    targets.add(target);
    return;
  }
  map.set(source, new Set([target]));
}

/** True when `source -> target` was classified as a back edge. */
export function isBackEdge(
  backEdgesBySource: BackEdgesBySource,
  source: string,
  target: string
): boolean {
  return backEdgesBySource.get(source)?.has(target) === true;
}

/** Every edge that closes a cycle. Empty for an acyclic graph. */
export function findBackEdges(
  nodes: BackEdgeNode[],
  edges: BackEdgeLike[]
): Map<string, Set<string>> {
  const outgoing = buildOutgoing(edges);
  const state = new Map<string, number>();
  const backEdges = new Map<string, Set<string>>();

  for (const start of startOrder(nodes, edges)) {
    if ((state.get(start) ?? UNVISITED) !== UNVISITED) {
      continue;
    }
    state.set(start, ON_STACK);
    const stack: Array<{ id: string; nextEdge: number }> = [
      { id: start, nextEdge: 0 },
    ];

    while (stack.length > 0) {
      const frame = stack.at(-1) as { id: string; nextEdge: number };
      const outEdges = outgoing.get(frame.id) ?? [];
      if (frame.nextEdge >= outEdges.length) {
        state.set(frame.id, EXPLORED);
        stack.pop();
        continue;
      }
      const edge = outEdges[frame.nextEdge];
      frame.nextEdge += 1;

      const targetState = state.get(edge.target) ?? UNVISITED;
      if (targetState === ON_STACK) {
        record(backEdges, edge.source, edge.target);
        continue;
      }
      if (targetState === EXPLORED) {
        continue;
      }
      state.set(edge.target, ON_STACK);
      stack.push({ id: edge.target, nextEdge: 0 });
    }
  }

  return backEdges;
}

export type BackEdgePartition<E extends BackEdgeLike> = {
  forwardEdges: E[];
  backEdges: E[];
  backEdgesBySource: BackEdgesBySource;
};

/**
 * Split a workflow's edges into the forward DAG and the loop-back edges.
 * Parallel edges between the same pair are classified together, since the loop
 * entry is the same node whichever handle they leave from.
 */
export function partitionByBackEdges<E extends BackEdgeLike>(
  nodes: BackEdgeNode[],
  edges: E[]
): BackEdgePartition<E> {
  const backEdgesBySource = findBackEdges(nodes, edges);
  if (backEdgesBySource.size === 0) {
    return { forwardEdges: edges, backEdges: [], backEdgesBySource };
  }

  const forwardEdges: E[] = [];
  const backEdges: E[] = [];
  for (const edge of edges) {
    if (isBackEdge(backEdgesBySource, edge.source, edge.target)) {
      backEdges.push(edge);
    } else {
      forwardEdges.push(edge);
    }
  }
  return { forwardEdges, backEdges, backEdgesBySource };
}

/**
 * Every node reachable from `startId` over the given adjacency, including
 * `startId` itself. Called with the forward map it gives a loop's re-run scope:
 * re-entering the loop entry runs it and everything it feeds.
 */
export function collectReachable(
  startId: string,
  edgesBySource: ReadonlyMap<string, string[]>
): Set<string> {
  const reachable = new Set<string>([startId]);
  const queue: string[] = [startId];

  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const next of edgesBySource.get(current) ?? []) {
      if (reachable.has(next)) {
        continue;
      }
      reachable.add(next);
      queue.push(next);
    }
  }

  return reachable;
}
