/**
 * Shared utility for building handle-aware edge maps.
 * Used by both the workflow executor and codegen to resolve
 * Condition node true/false routing targets.
 */

type EdgeLike = {
  source: string;
  target: string;
  sourceHandle?: string | null;
};

/** Map from source node ID to handle ID to target node IDs. */
export type EdgesBySourceHandle = Map<string, Map<string, string[]>>;

/**
 * Build a map of edges grouped by source node ID and source handle.
 * Only edges with a truthy `sourceHandle` are included.
 */
export function buildEdgesBySourceHandle(
  edges: EdgeLike[]
): EdgesBySourceHandle {
  const result: EdgesBySourceHandle = new Map();

  for (const edge of edges) {
    if (!edge.sourceHandle) {
      continue;
    }
    let handleMap = result.get(edge.source);
    if (!handleMap) {
      handleMap = new Map<string, string[]>();
      result.set(edge.source, handleMap);
    }
    const targets = handleMap.get(edge.sourceHandle) || [];
    if (!targets.includes(edge.target)) {
      targets.push(edge.target);
    }
    handleMap.set(edge.sourceHandle, targets);
  }

  return result;
}
