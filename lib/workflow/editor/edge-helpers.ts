import type { Edge as XYFlowEdge } from "@xyflow/react";

/** Normalize handle IDs so null/undefined/"" compare equal. */
export function normalizeHandle(handle: string | null | undefined): string {
  return handle ?? "";
}

type EdgeLike = {
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
};

/** True if an edge with the same source/sourceHandle -> target/targetHandle
 * already exists. Allows multiple connections between the same pair when
 * they use different handles (e.g. Condition true/false to the same target). */
export function hasDuplicateEdge(
  edges: readonly XYFlowEdge[],
  candidate: EdgeLike
): boolean {
  const sh = normalizeHandle(candidate.sourceHandle);
  const th = normalizeHandle(candidate.targetHandle);
  return edges.some(
    (e) =>
      e.source === candidate.source &&
      e.target === candidate.target &&
      normalizeHandle(e.sourceHandle) === sh &&
      normalizeHandle(e.targetHandle) === th
  );
}

/** Return a new array with duplicate edges removed, preserving first occurrence.
 * Duplicate is defined identically to {@link hasDuplicateEdge}. */
export function dedupeEdges<E extends EdgeLike>(edges: readonly E[]): E[] {
  const seen = new Set<string>();
  const result: E[] = [];
  for (const edge of edges) {
    const key = `${edge.source}\u0000${normalizeHandle(edge.sourceHandle)}\u0000${edge.target}\u0000${normalizeHandle(edge.targetHandle)}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(edge);
    }
  }
  return result;
}
