/**
 * Strict-mode template resolution support for the workflow executor.
 *
 * Background (KEEP-468): unresolved `{{...}}` references previously
 * substituted to empty string or the literal `{{...}}` token, allowing
 * corrupted values to flow into downstream actions including on-chain
 * writes. This module provides the tracker, error type, and post-scan
 * used by the resolver path to fail closed on any unresolved reference.
 *
 * KEEP-525 removed the `KEEPERHUB_TEMPLATE_RESOLVE_MODE=legacy` opt-out;
 * strict is now the only mode and `assertResolved` always throws on any
 * unresolved reference.
 */

const TEMPLATE_LITERAL_SCAN = /\{\{[^}]+\}\}/g;

export type UnresolvedReason =
  | "no-node"
  | "no-data"
  | "no-path"
  | "literal-leftover";

export type UnresolvedRef = {
  token: string;
  reason: UnresolvedReason;
  detail?: string;
  /**
   * Where in the rendered config the token was found, as a dotted path with
   * bracket indices, for example `group.rules[0].leftOperand`. Present for
   * leftover literals, which are the case where the token's own spelling is
   * often correct and the field holding it is the actual fault.
   */
  path?: string;
};

export type TemplateResolutionTracker = {
  unresolved: UnresolvedRef[];
};

export class TemplateResolutionError extends Error {
  readonly unresolved: UnresolvedRef[];

  constructor(unresolved: UnresolvedRef[]) {
    super(formatErrorMessage(unresolved));
    this.name = "TemplateResolutionError";
    this.unresolved = unresolved;
  }
}

export function createTracker(): TemplateResolutionTracker {
  return { unresolved: [] };
}

export function recordUnresolved(
  tracker: TemplateResolutionTracker | undefined,
  ref: UnresolvedRef
): void {
  if (!tracker) {
    return;
  }
  tracker.unresolved.push(ref);
}

/**
 * Recursively walk the rendered config looking for any leftover `{{...}}`
 * tokens. These are the literal-substitution path (executor.workflow.ts
 * displayPattern fallback): the resolver could not match the reference and
 * the original token was passed through unchanged.
 */
export function scanForLeftoverLiterals(
  value: unknown,
  out: UnresolvedRef[],
  depth = 0,
  path = ""
): void {
  if (depth > 10 || out.length > 50) {
    return;
  }
  if (typeof value === "string") {
    for (const match of value.matchAll(TEMPLATE_LITERAL_SCAN)) {
      out.push({
        token: match[0],
        reason: "literal-leftover",
        detail: "Reference left in rendered config; resolver did not match.",
        path: path || undefined,
      });
      if (out.length > 50) {
        return;
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      scanForLeftoverLiterals(item, out, depth + 1, `${path}[${index}]`);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      scanForLeftoverLiterals(
        item,
        out,
        depth + 1,
        path ? `${path}.${key}` : key
      );
    }
  }
}

/**
 * Aggregate tracker entries plus a fresh leftover-literal scan over the
 * rendered config and throw `TemplateResolutionError` if either source
 * reports anything. Always fails closed; KEEP-525 removed the legacy
 * silent-substitute opt-out.
 */
export function assertResolved(
  tracker: TemplateResolutionTracker,
  renderedConfig: unknown,
  _context: { nodeId?: string; nodeLabel?: string; actionType?: string }
): void {
  const literals: UnresolvedRef[] = [];
  scanForLeftoverLiterals(renderedConfig, literals);

  const all = dedupeByToken([...tracker.unresolved, ...literals]);
  if (all.length === 0) {
    return;
  }

  throw new TemplateResolutionError(all);
}

function dedupeByToken(refs: UnresolvedRef[]): UnresolvedRef[] {
  const seen = new Map<string, UnresolvedRef>();
  for (const ref of refs) {
    const key = `${ref.token}::${ref.reason}`;
    if (!seen.has(key)) {
      seen.set(key, ref);
    }
  }
  return Array.from(seen.values());
}

function formatErrorMessage(unresolved: UnresolvedRef[]): string {
  const summaries = unresolved.slice(0, 5).map((ref) => {
    // Naming the field matters when the token itself is spelled correctly and the
    // key holding it is the one the renderer never reached. Without it the message
    // sends the reader to rewrite a reference that was never wrong.
    const where = ref.path ? ` at ${ref.path}` : "";
    return ref.detail
      ? `${ref.token}${where} (${ref.detail})`
      : `${ref.token}${where}`;
  });
  const more =
    unresolved.length > summaries.length
      ? ` (+${unresolved.length - summaries.length} more)`
      : "";
  return `Unresolved template reference(s): ${summaries.join("; ")}${more}. The action was aborted to prevent silently writing empty or literal values. Fix the reference in the workflow definition.`;
}
