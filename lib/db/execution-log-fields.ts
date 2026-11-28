import { sql } from "drizzle-orm";
import { workflowExecutionLogs } from "@/lib/db/schema";

/**
 * Shared SQL builders for extracting a field from the double-encoded JSONB
 * columns on workflow_execution_logs.
 *
 * The `output` / `input` columns are double-encoded: Drizzle stores a JSON
 * string value inside JSONB (jsonb_typeof = 'string') rather than a JSONB
 * object. To read a nested key we first unwrap the string with `#>> '{}'`,
 * re-parse as jsonb, then extract. The ELSE branch handles any rows already
 * stored as a plain object.
 *
 * These builders are the source of truth for `gasUsed` (via `logOutputWei`) and
 * `network` extraction and MUST stay identical across every reader so they
 * agree value-for-value:
 *   - lib/analytics/queries.ts                     - the /analytics read paths
 *   - lib/workflow/executor/logging.ts              - writes the denormalised run-total
 *   - scripts/backfill-workflow-gas.ts              - backfills run totals
 *   - scripts/lib/exec-log-network-gas-backfill.ts  - backfills per-step columns
 * Keep them in one place precisely because they must never drift.
 */
function logOutputField(field: string): ReturnType<typeof sql> {
  return sql`CASE
    WHEN jsonb_typeof(${workflowExecutionLogs.output}) = 'string'
    THEN (${workflowExecutionLogs.output} #>> '{}')::jsonb->>${sql.raw(`'${field}'`)}
    ELSE ${workflowExecutionLogs.output}->>${sql.raw(`'${field}'`)}
  END`;
}

/** logOutputField as a numeric when it is a decimal integer of at most 78 digits (uint256), else NULL: a step's own output can hold anything. */
export function logOutputWei(field: string): ReturnType<typeof sql> {
  const text = logOutputField(field);
  return sql`CASE WHEN ${text} ~ '^[0-9]{1,78}$' THEN CAST(${text} AS NUMERIC) END`;
}

export function logInputField(field: string): ReturnType<typeof sql> {
  return sql`CASE
    WHEN jsonb_typeof(${workflowExecutionLogs.input}) = 'string'
    THEN (${workflowExecutionLogs.input} #>> '{}')::jsonb->>${sql.raw(`'${field}'`)}
    ELSE ${workflowExecutionLogs.input}->>${sql.raw(`'${field}'`)}
  END`;
}

// The JS side of logOutputWei's pattern: up to 78 digits, the width of a uint256.
const DECIMAL_INTEGER = /^[0-9]{1,78}$/;

/**
 * JS-side counterparts of the SQL extraction above, used by the executor writer
 * (lib/workflow/executor/logging.ts) to populate the denormalised `network` /
 * `gas_used_wei` columns at write time. They read the same raw input/output the
 * `input` / `output` JSONB columns receive, so a writer-populated column agrees
 * value-for-value with `logInputField`/`logOutputWei` and the backfill (which
 * uses the SQL builders). Mirror the `->>` semantics: only a plain-object source
 * yields a value, and the result is the scalar's text form.
 */
function jsonScalarText(source: unknown, field: string): string | null {
  if (source === null || typeof source !== "object" || Array.isArray(source)) {
    return null;
  }
  const value = (source as Record<string, unknown>)[field];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "object") {
    return null;
  }
  return String(value);
}

export function extractLogNetwork(input: unknown): string | null {
  return jsonScalarText(input, "network");
}

/**
 * Extract per-step gas as the text of a numeric (the `gas_used_wei` column is
 * numeric). Returns null unless the value is a decimal integer of at most 78
 * digits, the same rule as `logOutputWei` in SQL.
 */
export function extractLogGasUsedWei(output: unknown): string | null {
  const text = jsonScalarText(output, "gasUsed");
  return text !== null && DECIMAL_INTEGER.test(text) ? text : null;
}
