/**
 * Pure helper functions for For Each loop features.
 *
 * Shared by:
 *   - components/workflow/config/action-config.tsx (map expression dropdown)
 *   - components/ui/template-autocomplete.tsx (synthetic output for autocomplete)
 *   - lib/workflow-executor.workflow.ts (array source resolution)
 *   - tests/unit/action-config-helpers.test.ts
 *   - tests/unit/template-autocomplete-foreach.test.ts
 */

/** Matches `{{@nodeId:Label.fieldPath}}` templates used by array sources. */
export const ARRAY_SOURCE_RE = /^\{\{@([^:]+):([^.}]+)\.?([^}]*)\}\}$/;

/**
 * Traverse a dot-path into a nested value, returning null on failure.
 * Returns null for missing keys, non-object intermediates, arrays, and
 * null/undefined roots.
 */
export function traverseDotPath(root: unknown, path: string): unknown {
  let data: unknown = root;
  for (const part of path.split(".")) {
    if (data && typeof data === "object" && !Array.isArray(data)) {
      data = (data as Record<string, unknown>)[part];
      if (data === undefined) {
        return null;
      }
    } else {
      return null;
    }
  }
  return data;
}

/**
 * Recursively extract dot-paths from an object up to a max depth of 3.
 * Arrays are listed as keys but not recursed into.
 */
export function extractObjectPaths(
  obj: Record<string, unknown>,
  prefix: string,
  depth: number,
  paths: string[]
): void {
  if (depth > 3) {
    return;
  }
  for (const key of Object.keys(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    paths.push(path);
    const val = obj[key];
    if (val && typeof val === "object" && !Array.isArray(val)) {
      extractObjectPaths(
        val as Record<string, unknown>,
        path,
        depth + 1,
        paths
      );
    }
  }
}

/**
 * When the source node of a template is a For Each, resolve its synthetic
 * output (with currentItem) instead of the raw execution log metadata.
 */
function tryChainResolveForEach(
  sourceNodeId: string,
  executionLogs: Record<string, { output?: unknown }>,
  lastLogs: Record<string, { output?: unknown }>,
  allNodes: ForEachNode[],
  visited: Set<string>
): Record<string, unknown> | null {
  const sourceNode = allNodes.find(
    (n) =>
      n.id === sourceNodeId &&
      (n.data.config?.actionType as string | undefined) === "For Each"
  );
  if (!sourceNode || visited.has(sourceNodeId)) {
    return null;
  }
  return resolveForEachSyntheticOutput(
    sourceNode,
    executionLogs,
    lastLogs,
    allNodes,
    visited
  );
}

/**
 * Resolve an array source template to the raw array value.
 * Shared by resolveArraySourceElement and resolveForEachSyntheticOutput.
 * Returns null when the template is invalid, the source node has no output,
 * or the resolved value is not a non-empty array.
 *
 * When `allNodes` is provided and the source node is a For Each, the
 * resolution chain-resolves via the parent's synthetic output so that
 * nested For Each references (e.g., `{{@parent:Parent.currentItem.items}}`)
 * work correctly in autocomplete.
 */
function resolveArrayFromTemplate(
  arraySource: string,
  executionLogs: Record<string, { output?: unknown }>,
  lastLogs: Record<string, { output?: unknown }>,
  allNodes?: ForEachNode[],
  visited?: Set<string>
): unknown[] | null {
  const match = ARRAY_SOURCE_RE.exec(arraySource);
  if (!match) {
    return null;
  }

  const sourceNodeId = match[1];
  const fieldPath = match[3] || "";

  // Chain-resolve: if the source node is a For Each, use its synthetic output
  // instead of the raw execution log (which contains step metadata, not currentItem).
  const logOutput: unknown =
    executionLogs[sourceNodeId]?.output ?? lastLogs[sourceNodeId]?.output;
  const chainResolved = allNodes
    ? tryChainResolveForEach(
        sourceNodeId,
        executionLogs,
        lastLogs,
        allNodes,
        visited ?? new Set<string>()
      )
    : null;
  const sourceOutput = chainResolved ?? logOutput;

  if (sourceOutput === undefined || sourceOutput === null) {
    return null;
  }

  const data = fieldPath
    ? traverseDotPath(sourceOutput, fieldPath)
    : sourceOutput;
  if (!Array.isArray(data) || data.length === 0) {
    return null;
  }

  return data;
}

/**
 * Resolve an array source template to the first element of the referenced
 * array. Returns null when the template is invalid, the source node has no
 * output, the resolved value is not an array, the array is empty, or the
 * first element is not a plain object.
 */
export function resolveArraySourceElement(
  arraySource: string,
  executionLogs: Record<string, { output?: unknown }>,
  lastLogs: Record<string, { output?: unknown }>,
  allNodes?: ForEachNode[]
): Record<string, unknown> | null {
  const data = resolveArrayFromTemplate(
    arraySource,
    executionLogs,
    lastLogs,
    allNodes
  );
  if (!data) {
    return null;
  }

  const first = data[0];
  if (!first || typeof first !== "object" || Array.isArray(first)) {
    return null;
  }

  return first as Record<string, unknown>;
}

type ExecutionLogEntry = { output?: unknown };

type ForEachNode = {
  id: string;
  data: {
    config?: Record<string, unknown>;
  };
};

/**
 * For a For Each node, resolve the arraySource to build a synthetic output
 * containing the first array element as `currentItem`. This enables
 * getAvailableFields to enumerate nested object keys in autocomplete.
 *
 * When `allNodes` is provided, nested For Each references are chain-resolved
 * so that `{{@parent:Parent.currentItem.items}}` works correctly.
 */
export function resolveForEachSyntheticOutput(
  node: ForEachNode,
  executionLogs: Record<string, ExecutionLogEntry>,
  lastLogs: Record<string, ExecutionLogEntry>,
  allNodes?: ForEachNode[],
  visited?: Set<string>
): Record<string, unknown> | null {
  const arraySource = node.data.config?.arraySource as string | undefined;
  if (!arraySource) {
    return null;
  }

  // Track visited nodes to prevent infinite recursion on circular references
  const currentVisited = visited ?? new Set<string>();
  currentVisited.add(node.id);

  const data = resolveArrayFromTemplate(
    arraySource,
    executionLogs,
    lastLogs,
    allNodes,
    currentVisited
  );
  if (!data) {
    return null;
  }

  // Apply mapExpression to transform currentItem, matching executor behavior
  let currentItem: unknown = data[0];
  const mapExpression = node.data.config?.mapExpression as string | undefined;
  if (mapExpression && currentItem && typeof currentItem === "object") {
    const mapped = traverseDotPath(currentItem, mapExpression);
    if (mapped !== null) {
      currentItem = mapped;
    }
  }

  return {
    currentItem,
    index: 0,
    totalItems: data.length,
  };
}
