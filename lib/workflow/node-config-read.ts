type UnknownRecord = Record<string, unknown>;

export function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null
    ? (value as UnknownRecord)
    : null;
}

/**
 * Read a node-config field, preferring `data.config.<field>` but falling back
 * to the legacy top-level `data.<field>`.
 */
export function readNodeConfigField(
  data: UnknownRecord | null,
  config: UnknownRecord | null,
  field: string
): unknown {
  const fromConfig = config?.[field];
  return fromConfig === undefined ? data?.[field] : fromConfig;
}

/**
 * Normalize colon-separated action types (`code:run-code`) to the slash form
 * (`code/run-code`).
 */
export function normalizeActionType(value: unknown): string | undefined {
  return typeof value === "string" ? value.replace(":", "/") : undefined;
}

/**
 * Bounds for {@link walkNodeConfigStrings}. They keep validators predictable
 * on adversarial input: workflow `nodes` payloads are DB-resident, so a
 * malicious row could otherwise blow the V8 stack (~20k depth) or pin a
 * worker on a multi-MB string field. Strings over the length bound are
 * skipped entirely, not truncated.
 */
const MAX_DEPTH = 100;
const MAX_STRING_LENGTH = 256_000;

type NodeConfigStringVisitor = (
  value: string,
  node: unknown
) => boolean | undefined;

type WalkContext = {
  node: unknown;
  maxDepth: number;
  maxStringLength: number;
  onString: NodeConfigStringVisitor;
};

/** Returns true when the visitor asked to stop the walk. */
function visitConfigValue(
  value: unknown,
  depth: number,
  ctx: WalkContext
): boolean {
  if (depth > ctx.maxDepth) {
    return false;
  }
  if (typeof value === "string") {
    if (value.length > ctx.maxStringLength) {
      return false;
    }
    return ctx.onString(value, ctx.node) === true;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (visitConfigValue(item, depth + 1, ctx)) {
        return true;
      }
    }
    return false;
  }
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) {
      if (visitConfigValue(item, depth + 1, ctx)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Depth-, length-, and findings-bounded traversal over every string reachable
 * from each node's `data.config`, in node order then depth-first order.
 *
 * `onString` is invoked for each in-bounds string; the node it belongs to is
 * passed alongside. Returning `true` stops the whole walk - callers use this
 * to cap their finding count. Non-array `nodes` payloads and nodes without a
 * config are skipped, matching the tolerant shape handling of the validators
 * this consolidates (lib/mcp/listing-validators.ts and
 * lib/workflow/validation/template-syntax.ts).
 */
export function walkNodeConfigStrings(
  nodes: unknown,
  onString: NodeConfigStringVisitor
): void {
  if (!Array.isArray(nodes)) {
    return;
  }
  for (const node of nodes) {
    const config = asRecord(asRecord(node)?.data)?.config;
    if (config === undefined || config === null) {
      continue;
    }
    const stopped = visitConfigValue(config, 0, {
      node,
      maxDepth: MAX_DEPTH,
      maxStringLength: MAX_STRING_LENGTH,
      onString,
    });
    if (stopped) {
      return;
    }
  }
}
