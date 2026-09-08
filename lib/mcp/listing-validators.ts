/**
 * Pure validators for the workflow listing flow.
 *
 * These functions inspect the workflow `nodes` payload and the desired
 * `inputSchema` to catch authoring mistakes that would otherwise reach the
 * bazaar in a broken state — e.g. an `@40` literal where the editor's `@`
 * autocomplete was dismissed mid-typing, or a listed workflow with a null
 * inputSchema (which leaves bazaar consumers unable to render or validate
 * inputs).
 *
 * Kept free of DB/framework dependencies so they're easy to unit-test without
 * mocks; the only import is the shared bounded node-config walker, which is
 * itself dependency-free.
 */

import { walkNodeConfigStrings } from "@/lib/workflow/node-config-read";

// Linear-time strip of wrapped templates. The `[^{}]*` form (vs `[^}]*`) avoids
// the V8 quadratic-replace pathology when input contains long runs of unmatched
// `{`s — `current.nodes` is DB-resident, so a malicious workflow row would
// otherwise pin a worker for tens of seconds at the listing call.
const TEMPLATE_PATTERN = /\{\{[^{}]*\}\}/g;
// Match @<word>(-<word>)* preceded by start-of-string or any non-word, non-`@`
// character. The broad prefix catches quote/equals/bracket-wrapped trapped
// states (e.g. `condition: "@trigger-1"`, `key=@val`, `("@nested")`) that a
// narrower delimiter list would miss; emails (`a@b.com`) and intra-token `@`s
// remain unflagged because the prefix requires the `@` to NOT follow a word
// character.
const BARE_AT_PATTERN = /(?:^|[^\w@])(@\w+(?:-\w+)*)/g;

// Findings cap for this gate. Depth and string-length bounds come from
// walkNodeConfigStrings' defaults (lib/workflow/node-config-read.ts), which
// keep the walk predictable on adversarial DB-resident input.
const MAX_FINDINGS = 10;

// Action-type prefixes whose configs legitimately embed `@<word>` content
// (Discord/Slack/Telegram mentions, AI-prompt natural language, TypeScript
// decorators in code blocks). Skipped wholesale to avoid false positives on
// the bazaar's most common authoring shapes.
const SKIP_ACTION_TYPE_PREFIXES = [
  "code/",
  "notify/",
  "discord/",
  "slack/",
  "telegram/",
  "email/",
  "ai/",
  "ai-gateway/",
];

type NodeLike = {
  id?: unknown;
  type?: unknown;
  data?: {
    actionType?: unknown;
    config?: { actionType?: unknown } & Record<string, unknown>;
  } & Record<string, unknown>;
} & Record<string, unknown>;

/**
 * Reads the action type from either `data.config.actionType` or the legacy
 * `data.actionType` fallback (mirroring `findFirstWriteActionNode` in
 * `lib/mcp/calldata.ts`). Normalizes colon-separated forms (`code:run-code`)
 * to slash-separated (`code/run-code`) — sanitize-nodes does the same on the
 * write path, but in-flight or legacy fixtures may still carry the colon form.
 */
function getNormalizedActionType(node: NodeLike): string {
  const fromConfig =
    typeof node?.data?.config?.actionType === "string"
      ? (node.data.config.actionType as string)
      : "";
  const fromData =
    typeof node?.data?.actionType === "string"
      ? (node.data.actionType as string)
      : "";
  const raw = fromConfig || fromData;
  return raw.replace(":", "/");
}

function shouldSkipForAtDetection(node: NodeLike): boolean {
  const actionType = getNormalizedActionType(node);
  if (actionType === "") {
    return false;
  }
  return SKIP_ACTION_TYPE_PREFIXES.some((prefix) =>
    actionType.startsWith(prefix)
  );
}

/**
 * Returns up to MAX_FINDINGS bare-@ literals found in workflow node configs.
 *
 * A bare-@ literal is an `@<word>` token that appears OUTSIDE a `{{...}}`
 * template wrapper — i.e. the trapped state when a user types `@` in the
 * editor and dismisses autocomplete before completing a `{{@nodeId:...}}`
 * reference. These would survive listing and silently break at runtime
 * because the executor only resolves wrapped templates.
 *
 * Nodes whose action type matches `SKIP_ACTION_TYPE_PREFIXES` are skipped to
 * avoid false positives on legitimate `@`-bearing content (Discord/Slack
 * mentions, AI prompts, TS decorators in code blocks).
 */
export function findBareAtLiterals(nodes: unknown): string[] {
  if (!Array.isArray(nodes)) {
    return [];
  }

  const eligible = nodes.filter(
    (node) => !shouldSkipForAtDetection(node as NodeLike)
  );
  const findings: string[] = [];

  walkNodeConfigStrings(eligible, (value) => {
    const stripped = value.replace(TEMPLATE_PATTERN, "");
    for (const m of stripped.matchAll(BARE_AT_PATTERN)) {
      findings.push(m[1]);
      if (findings.length >= MAX_FINDINGS) {
        return true;
      }
    }
    return false;
  });

  return findings;
}

/**
 * Returns true if the given value is a non-null object that can serve as a
 * JSON-schema-shaped input declaration. Empty objects (e.g. `{type: "object"}`)
 * are accepted — the goal is to ensure the workflow declares *something* for
 * bazaar consumers to render, not to enforce schema completeness.
 */
export function isInputSchemaPresent(schema: unknown): boolean {
  return (
    typeof schema === "object" && schema !== null && !Array.isArray(schema)
  );
}
