import { createHash } from "node:crypto";

/**
 * Stable fingerprint of a workflow definition (its nodes + edges). Two
 * purposes that must agree on the same value:
 *
 * - stamped onto `workflow_executions.executed_workflow_hash` at trigger time
 *   so a run is tied to the exact definition that produced it, even after the
 *   workflow is later edited; and
 * - stored as `workflow_history.content_hash` for each saved version, so the
 *   execution's hash resolves to a stored snapshot by an indexed equality join
 *   with no snapshot duplication on the high-volume executions table.
 *
 * The hash (and the history diff that reuses the same normalization) covers
 * the MEANINGFUL definition only: node identity + type + data, and edge
 * connectivity (source/target/handles, which the executor uses to build the
 * run graph). Purely cosmetic ReactFlow state -- node position, selection,
 * measured size, edge styling -- is dropped, so dragging a node around does
 * not produce a new "version" while adding or removing a connection does.
 *
 * Object keys are sorted recursively so semantically identical definitions
 * hash identically (a revert to a prior state reproduces its hash). Array
 * order is preserved -- node/edge ordering is part of the stored definition.
 */

// Meaningful keys kept per node/edge. Everything else (position, selected,
// dragging, width/height, measured, style, animated, markers, zIndex, ...) is
// rendering state and excluded from the hash/diff.
const NODE_KEYS = ["id", "type", "data"] as const;
const EDGE_KEYS = [
  "id",
  "source",
  "target",
  "sourceHandle",
  "targetHandle",
  "data",
] as const;

function pick(value: unknown, keys: readonly string[]): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (source[key] !== undefined) {
      out[key] = source[key];
    }
  }
  return out;
}

function pickAll(items: unknown, keys: readonly string[]): unknown[] {
  return Array.isArray(items) ? items.map((item) => pick(item, keys)) : [];
}

/**
 * Reduce a workflow definition to the fields that affect behavior, dropping
 * cosmetic state. Used for both the content hash and the history diff so the
 * two never disagree.
 */
export function normalizeWorkflowDefinition(
  nodes: unknown,
  edges: unknown
): { nodes: unknown[]; edges: unknown[] } {
  return {
    nodes: pickAll(nodes, NODE_KEYS),
    edges: pickAll(edges, EDGE_KEYS),
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = canonicalize(source[key]);
    }
    return sorted;
  }
  return value;
}

export function hashWorkflowDefinition(nodes: unknown, edges: unknown): string {
  const canonical = JSON.stringify(
    canonicalize(normalizeWorkflowDefinition(nodes, edges))
  );
  return createHash("sha256").update(canonical).digest("hex");
}
