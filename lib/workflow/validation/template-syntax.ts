/**
 * KEEP-468: PATCH-time validator for `{{...}}` template tokens.
 *
 * Catches grammar typos at workflow save time so they fail with a clear
 * 400 instead of running through the editor and surprising authors at
 * runtime. Three supported grammars (see docs/templating.md):
 *
 *   - Stored:   `{{@nodeId:Label[.path]}}`  — colon required, both sides nonempty
 *   - Legacy $: `{{$nodeId[.path]}}`        — content after `$` nonempty
 *   - Display:  `{{Label[.path]}}`          — nonempty after trim, no leading `@`/`$`
 *
 * Any token that doesn't match one of the three is reported. The walker
 * mirrors `findBareAtLiterals` (lib/mcp/listing-validators.ts) so DB-rooted
 * adversarial input can't pin a worker: bounded depth, string length, and
 * finding count.
 */

const TEMPLATE_PATTERN = /\{\{([^{}]*)\}\}/g;
const STORED_PATTERN = /^@([^:]+):([\s\S]+)$/;
const DOLLAR_PATTERN = /^\$([\s\S]+)$/;

const MAX_DEPTH = 100;
const MAX_STRING_LEN = 256_000;
const MAX_FINDINGS = 25;

export type InvalidTemplateReason =
  | "empty"
  | "malformed-stored"
  | "malformed-dollar";

export type InvalidTemplate = {
  token: string;
  reason: InvalidTemplateReason;
  detail: string;
  nodeId?: string;
};

type NodeLike = {
  id?: unknown;
  data?: { config?: Record<string, unknown> } & Record<string, unknown>;
} & Record<string, unknown>;

/**
 * Validate a single `{{...}}` token body (the content between the braces,
 * NOT the wrapped form). Returns null if the body parses to one of the
 * supported grammars; otherwise returns the reason the parser rejected it.
 */
export function validateTemplateBody(
  body: string
): { reason: InvalidTemplateReason; detail: string } | null {
  const trimmed = body.trim();
  if (trimmed.length === 0) {
    return {
      reason: "empty",
      detail: "Template token is empty.",
    };
  }

  if (trimmed.startsWith("@")) {
    const match = trimmed.match(STORED_PATTERN);
    if (!match) {
      return {
        reason: "malformed-stored",
        detail:
          "Stored-format reference must use `{{@nodeId:Label}}` with a colon between nodeId and label.",
      };
    }
    const [, nodeId, rest] = match;
    if (nodeId.trim().length === 0 || rest.trim().length === 0) {
      return {
        reason: "malformed-stored",
        detail: "Stored-format reference has an empty nodeId or label.",
      };
    }
    return null;
  }

  if (trimmed.startsWith("$")) {
    const match = trimmed.match(DOLLAR_PATTERN);
    if (!match || match[1].trim().length === 0) {
      return {
        reason: "malformed-dollar",
        detail: "Legacy `$`-format reference must include a non-empty body.",
      };
    }
    return null;
  }

  // Display-format: any non-empty non-@/$ content is accepted at the
  // syntax layer. Resolution failure is caught by the runtime fail-closed
  // path (see lib/workflow/executor/template-resolution.ts).
  return null;
}

/**
 * Walk a workflow `nodes` payload and report up to MAX_FINDINGS invalid
 * template tokens. Returns an empty array when every `{{...}}` parses.
 */
export function findInvalidTemplateTokens(nodes: unknown): InvalidTemplate[] {
  if (!Array.isArray(nodes)) {
    return [];
  }

  const findings: InvalidTemplate[] = [];

  for (const node of nodes as NodeLike[]) {
    if (findings.length >= MAX_FINDINGS) {
      break;
    }
    const config = node?.data?.config;
    if (config === undefined || config === null) {
      continue;
    }
    const nodeId = typeof node?.id === "string" ? node.id : undefined;
    visit(config, findings, nodeId, 0);
  }

  return findings;
}

function visit(
  value: unknown,
  findings: InvalidTemplate[],
  nodeId: string | undefined,
  depth: number
): void {
  if (depth > MAX_DEPTH || findings.length >= MAX_FINDINGS) {
    return;
  }
  if (typeof value === "string") {
    if (value.length > MAX_STRING_LEN) {
      return;
    }
    for (const match of value.matchAll(TEMPLATE_PATTERN)) {
      const result = validateTemplateBody(match[1]);
      if (result) {
        findings.push({
          token: match[0],
          reason: result.reason,
          detail: result.detail,
          ...(nodeId ? { nodeId } : {}),
        });
        if (findings.length >= MAX_FINDINGS) {
          return;
        }
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      visit(item, findings, nodeId, depth + 1);
      if (findings.length >= MAX_FINDINGS) {
        return;
      }
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      visit(item, findings, nodeId, depth + 1);
      if (findings.length >= MAX_FINDINGS) {
        return;
      }
    }
  }
}
