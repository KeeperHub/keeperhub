/**
 * Pre-execution content-pattern scanner. Walks every node's config JSON AND
 * the trigger input payload for suspicious patterns and emits a single
 * Sentry / structured-stdout event per workflow run summarising any hits.
 * Alert-only in v0; the env flag `CONTENT_SCANNER_ENFORCE` is reserved for
 * a follow-up that converts matches into hard blocks once baseline noise
 * is understood.
 *
 * The pattern names are the alert grouping key. The actual matched value
 * never leaves this module: alerts must be readable without exposing the
 * credentials they detect. Add patterns by appending to `PATTERNS` and
 * extending `tests/unit/content-scanner.test.ts`.
 *
 * Why scan trigger input separately from node config: an attacker can
 * inject a malicious string via a webhook body or scheduled trigger payload
 * that templating later renders into a downstream node's input. The static
 * config alone misses this entry point. Scanning trigger input at workflow
 * start catches the injection at the boundary; intermediate-node outputs
 * are not scanned because they're more likely to surface benign third-party
 * substrings (e.g. an OAuth provider's docs URL containing `refresh_token`).
 *
 * KEEP-612: bullet "Content-pattern alerts on workflow node config and
 * execution payloads: 169.254.169.254, information_schema, pg_catalog,
 * neon_auth, refresh_token, client_secret, DATABASE_URL".
 */

import { logSecurityEvent } from "@/lib/logging";

type Pattern = {
  readonly name: string;
  readonly regex: RegExp;
};

const PATTERNS: readonly Pattern[] = [
  { name: "imds_metadata_ip", regex: /169\.254\.169\.254/ },
  { name: "pg_information_schema", regex: /\binformation_schema\b/i },
  { name: "pg_catalog", regex: /\bpg_catalog\b/i },
  { name: "neon_auth", regex: /\bneon_auth\b/i },
  { name: "refresh_token", regex: /\brefresh_token\b/i },
  { name: "client_secret", regex: /\bclient_secret\b/i },
  // Case-insensitive: env templates routinely use lowercase `database_url`
  // (e.g. {{env.database_url}}), which the case-sensitive form silently missed.
  { name: "database_url", regex: /\bDATABASE_URL\b/i },
];

// Bound on recursion depth and total hits. triggerInput is attacker-
// controllable (webhook body via request.json()), so an adversarial deeply
// nested payload could otherwise stack-overflow scanValue or build an
// unbounded hits array. 64 levels is far deeper than any real workflow
// config; 1000 hits is far more than any genuine match set. When the hit
// cap is reached we append a single `scan_truncated` marker hit and stop,
// so the report is bounded AND the truncation is observable (hitting the
// cap is itself suspicious) rather than silently dropped.
const MAX_SCAN_DEPTH = 64;
const MAX_HITS = 1000;
const TRUNCATION_PATTERN = "scan_truncated";

export type ContentScanHitSource = "config" | "trigger_input";

export type ContentScanHit = {
  source: ContentScanHitSource;
  pattern: string;
  nodeId: string;
  nodeType: string;
  jsonPath: string;
};

export type WorkflowNodeLike = {
  id: string;
  data?: {
    type?: string;
    config?: unknown;
  };
};

export type ScanContext = {
  workflowId?: string;
  executionId?: string;
  organizationId?: string;
};

const TRIGGER_INPUT_PSEUDO_NODE_ID = "trigger_input";
const TRIGGER_INPUT_PSEUDO_NODE_TYPE = "trigger";

// Both scanners accept an optional shared `hits` accumulator so a single
// execution's config + trigger-input scan share ONE MAX_HITS budget (the cap
// is enforced in scanValue against hits.length). Called standalone in tests
// they default to a fresh array.
export function scanNodes(
  nodes: readonly WorkflowNodeLike[],
  hits: ContentScanHit[] = []
): ContentScanHit[] {
  for (const node of nodes) {
    const config = node.data?.config;
    if (config === undefined || config === null) {
      continue;
    }
    scanValue(
      config,
      `${node.id}.config`,
      {
        source: "config",
        nodeId: node.id,
        nodeType: node.data?.type ?? "unknown",
      },
      hits,
      0
    );
  }
  return hits;
}

export function scanTriggerInput(
  triggerInput: unknown,
  hits: ContentScanHit[] = []
): ContentScanHit[] {
  if (triggerInput === undefined || triggerInput === null) {
    return hits;
  }
  scanValue(
    triggerInput,
    TRIGGER_INPUT_PSEUDO_NODE_ID,
    {
      source: "trigger_input",
      nodeId: TRIGGER_INPUT_PSEUDO_NODE_ID,
      nodeType: TRIGGER_INPUT_PSEUDO_NODE_TYPE,
    },
    hits,
    0
  );
  return hits;
}

type HitMetadata = {
  source: ContentScanHitSource;
  nodeId: string;
  nodeType: string;
};

function scanValue(
  value: unknown,
  path: string,
  meta: HitMetadata,
  hits: ContentScanHit[],
  depth: number
): void {
  // Hard caps: triggerInput is attacker-controllable, so refuse to recurse
  // past MAX_SCAN_DEPTH (stack-overflow guard) or accumulate past MAX_HITS.
  // `> MAX_HITS` (strict) so the single appended truncation marker, which
  // takes the count to MAX_HITS + 1, terminates all further scanning.
  if (depth > MAX_SCAN_DEPTH || hits.length > MAX_HITS) {
    return;
  }
  if (typeof value === "string") {
    for (const pattern of PATTERNS) {
      if (!pattern.regex.test(value)) {
        continue;
      }
      // Enforce the cap at the push site (a single string can match several
      // patterns). On reaching it, append exactly one observable marker and
      // stop -- the report stays bounded and truncation is not silent.
      if (hits.length >= MAX_HITS) {
        hits.push({
          source: meta.source,
          pattern: TRUNCATION_PATTERN,
          nodeId: meta.nodeId,
          nodeType: meta.nodeType,
          jsonPath: path,
        });
        return;
      }
      hits.push({
        source: meta.source,
        pattern: pattern.name,
        nodeId: meta.nodeId,
        nodeType: meta.nodeType,
        jsonPath: path,
      });
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      scanValue(item, `${path}[${index}]`, meta, hits, depth + 1);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(
      value as Record<string, unknown>
    )) {
      scanValue(child, `${path}.${key}`, meta, hits, depth + 1);
    }
  }
}

/**
 * Dedupe by (source, nodeId, pattern) so a config with the same pattern in
 * 100 places contributes one tuple per source to the report rather than
 * 100. Source is part of the key so a pattern that appears in both static
 * config AND trigger input emits two rows (different attack surfaces).
 */
function dedupeHits(hits: readonly ContentScanHit[]): ContentScanHit[] {
  const seen = new Set<string>();
  const unique: ContentScanHit[] = [];
  for (const hit of hits) {
    const key = `${hit.source}:${hit.nodeId}:${hit.pattern}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(hit);
  }
  return unique;
}

export function emitScanReport(
  hits: readonly ContentScanHit[],
  context: ScanContext
): void {
  if (hits.length === 0) {
    return;
  }
  const unique = dedupeHits(hits);
  // Best-effort dual emit (Sentry + structured stdout); logSecurityEvent
  // self-guards both so a transport failure can never escape into the
  // executor or change workflow execution semantics.
  logSecurityEvent(
    "content_scanner_hit",
    {
      workflowId: context.workflowId,
      executionId: context.executionId,
      organizationId: context.organizationId,
      hitCount: unique.length,
      hits: unique,
    },
    {
      tags: { security: "content_scanner_hit" },
      extra: {
        workflowId: context.workflowId,
        executionId: context.executionId,
        organizationId: context.organizationId,
        hitCount: unique.length,
        hits: unique,
      },
    }
  );
}

/**
 * Convenience entry point: scan static node config + trigger input in one
 * pass and emit a single combined report. Use this from the executor
 * unless you need the raw hit list (tests do).
 */
export function scanAndReport(
  input:
    | readonly WorkflowNodeLike[]
    | {
        nodes: readonly WorkflowNodeLike[];
        triggerInput?: unknown;
      },
  context: ScanContext
): void {
  // Total by contract: the scanner is an alert-only detection probe and must
  // NEVER throw into the executor (the call site in executor.workflow.ts is
  // outside any try/catch). The depth/hit caps in scanValue make a throw
  // unlikely, but this outer guard is the hard guarantee -- a bug here
  // degrades detection, it does not break workflow execution.
  try {
    // `Array.isArray` does not narrow `readonly` arrays inside a union, so
    // discriminate via the `nodes` property instead. The object branch is
    // the only one that carries a `nodes` field.
    const isBareArray = !(
      input !== null &&
      typeof input === "object" &&
      "nodes" in input
    );
    const nodes = isBareArray
      ? (input as readonly WorkflowNodeLike[])
      : input.nodes;
    const triggerInput = isBareArray ? undefined : input.triggerInput;
    // One shared accumulator so config + trigger-input scans share a single
    // MAX_HITS budget (a saturating config can't be doubled by trigger input).
    const hits: ContentScanHit[] = [];
    scanNodes(nodes, hits);
    scanTriggerInput(triggerInput, hits);
    emitScanReport(hits, context);
  } catch (error) {
    // The scan must never throw into the executor. But swallowing silently
    // would drop detection to zero with no signal -- the exact "controls run
    // but nobody is watching" blind spot this layer exists to remove. Emit
    // one structured line (self-guarded so the failure-signal can't escape
    // either) so a probe that quietly stopped working is itself observable.
    // Log-only self-signal (no Sentry by design); logSecurityEvent self-guards
    // emission so it can never escape into the executor.
    logSecurityEvent("content_scanner_error", {
      workflowId: context.workflowId,
      executionId: context.executionId,
      organizationId: context.organizationId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
