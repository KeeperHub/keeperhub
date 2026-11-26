import { type AnyColumn, type SQL, sql } from "drizzle-orm";

/**
 * A finished run that would be a success but is not: a transaction in it did
 * not land (`not_landed`), or it sent nothing because an earlier run's bundle
 * was still in flight (`skipped`).
 */
export type RunOutcome = "skipped" | "not_landed";

/** What the run's steps said, merged over every successful step. */
export type RunOutcomeSignals = {
  skippedInFlight: boolean;
  notIncluded: boolean;
};

/** The output keys a step sets the run outcome with, shared by the TS and SQL readers. */
export const RUN_OUTCOME_OUTPUT = {
  routeKey: "route",
  skippedInFlightRoute: "skipped-in-flight",
  notIncludedReasonKey: "notIncludedReason",
} as const;

// Only Write Contract (and its legacy name) sends bundles, so only it may set the outcome.
const RUN_OUTCOME_ACTION_TYPES: readonly string[] = [
  "web3/write-contract",
  "Write Contract",
];

export const NO_RUN_OUTCOME_SIGNALS: RunOutcomeSignals = {
  skippedInFlight: false,
  notIncluded: false,
};

/** The signals one successful step's output carries; none unless it is Write Contract. */
export function signalsOfStep(
  nodeType: string,
  output: unknown
): RunOutcomeSignals {
  if (
    !RUN_OUTCOME_ACTION_TYPES.includes(nodeType) ||
    output === null ||
    typeof output !== "object" ||
    Array.isArray(output)
  ) {
    return NO_RUN_OUTCOME_SIGNALS;
  }
  const fields = output as Record<string, unknown>;
  const reason = fields[RUN_OUTCOME_OUTPUT.notIncludedReasonKey];
  return {
    skippedInFlight:
      fields[RUN_OUTCOME_OUTPUT.routeKey] ===
      RUN_OUTCOME_OUTPUT.skippedInFlightRoute,
    notIncluded: typeof reason === "string" && hasVisibleText(reason),
  };
}

// Zero-width characters JS whitespace misses; a reason of only these is blank.
const ZERO_WIDTH = new Set([0x20_0b, 0x20_0c, 0x20_0d, 0xfe_ff]);
const WHITESPACE_RE = /\s/u;

function hasVisibleText(text: string): boolean {
  for (const char of text) {
    if (
      !(WHITESPACE_RE.test(char) || ZERO_WIDTH.has(char.codePointAt(0) ?? 0))
    ) {
      return true;
    }
  }
  return false;
}

export function mergeSignals(
  a: RunOutcomeSignals,
  b: RunOutcomeSignals
): RunOutcomeSignals {
  return {
    skippedInFlight: a.skippedInFlight || b.skippedInFlight,
    notIncluded: a.notIncluded || b.notIncluded,
  };
}

export function hasSignal(signals: RunOutcomeSignals): boolean {
  return signals.skippedInFlight || signals.notIncluded;
}

/**
 * The outcome of a run that would otherwise be a success. A skip is only
 * `skipped` when no step in the run sent a transaction.
 */
export function runOutcomeOf(
  signals: RunOutcomeSignals,
  sentTransaction: boolean
): RunOutcome | undefined {
  if (signals.notIncluded) {
    return "not_landed";
  }
  if (signals.skippedInFlight) {
    return sentTransaction ? "not_landed" : "skipped";
  }
  return;
}

// Characters the SQL filter strips: a subset of what hasVisibleText skips,
// so the SQL stays a superset (space, tab to CR, zero-width, BOM).
const BLANK_CHARS_SQL = sql.raw(
  "U&' \\0009\\000A\\000B\\000C\\000D\\200B\\200C\\200D\\FEFF'"
);

// Constants only, as SQL literals: a bare parameter after -> is ambiguous (text or int).
const literal = (value: string): SQL => sql.raw(`'${value}'`);

type LogColumns = { nodeType: AnyColumn; outputRaw: AnyColumn };

/**
 * Each signal as a condition on one log row: this, not signalsOfStep, decides at
 * finalize. It strips fewer blanks, so it can say not landed where JS says landed.
 */
export function runOutcomeSignalSql(
  log: LogColumns
): Record<keyof RunOutcomeSignals, SQL> {
  const types = sql.join(RUN_OUTCOME_ACTION_TYPES.map(literal), sql`, `);
  const route = literal(RUN_OUTCOME_OUTPUT.routeKey);
  const reason = literal(RUN_OUTCOME_OUTPUT.notIncludedReasonKey);
  const writeContract = sql`${log.nodeType} IN (${types})`;
  return {
    skippedInFlight: sql`(${writeContract}
      AND ${log.outputRaw}->>${route} = ${literal(RUN_OUTCOME_OUTPUT.skippedInFlightRoute)})`,
    notIncluded: sql`(${writeContract}
      AND jsonb_typeof(${log.outputRaw}->${reason}) = 'string'
      AND btrim(${log.outputRaw}->>${reason}, ${BLANK_CHARS_SQL}) <> '')`,
  };
}

/** Log rows that may carry a signal: a superset of the rows signalsOfStep reads one from. */
export function runOutcomeLogSql(log: LogColumns): SQL {
  const { skippedInFlight, notIncluded } = runOutcomeSignalSql(log);
  return sql`(${skippedInFlight} OR ${notIncluded})`;
}
