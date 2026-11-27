import { type AnyColumn, type SQL, sql } from "drizzle-orm";
import {
  BUNDLE_STEP_ACTION_TYPES,
  RUN_OUTCOME_OUTPUT,
  RUN_OUTCOME_REASON,
  type RunOutcomeSignals,
} from "./run-outcome-keys";

// The step reader lives with the keys, so run views share it without SQL.
export {
  NO_RUN_OUTCOME_SIGNALS,
  type RunOutcomeSignals,
  signalsOfStep,
} from "./run-outcome-keys";

/**
 * A finished run that would be a success but is not: a bundle in it did not
 * land (`not_landed`), or a bundle step skipped because an earlier run's
 * bundle was still in flight (`skipped`, even when other steps sent).
 */
export type RunOutcome = "skipped" | "not_landed";

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
 * The outcome of a run that would otherwise be a success. A bundle that may
 * still land wins; a skip is `skipped` whatever other steps sent.
 */
export function runOutcomeOf(
  signals: RunOutcomeSignals
): RunOutcome | undefined {
  if (signals.notIncluded) {
    return "not_landed";
  }
  if (signals.skippedInFlight) {
    return "skipped";
  }
  return;
}

/**
 * The short reason a not landed or skipped run carries in `error`, so the
 * runs list says why. A late landing that settles the run clears it.
 */
export function runOutcomeReason(outcome: RunOutcome): string {
  return RUN_OUTCOME_REASON[outcome];
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
  const types = sql.join(BUNDLE_STEP_ACTION_TYPES.map(literal), sql`, `);
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

/**
 * The output keys a run view's step outcome reads, as SQL text (no step body
 * read). Only Write Contract rows can carry them: the outer CASE keeps every
 * other row from touching (detoasting) its output.
 */
export function stepOutcomeKeysSql(log: {
  nodeType: AnyColumn;
  output: AnyColumn;
}): {
  route: SQL<string | null>;
  notIncludedReason: SQL<string | null>;
} {
  const { nodeType, output } = log;
  const types = sql.join(BUNDLE_STEP_ACTION_TYPES.map(literal), sql`, `);
  // Only a JSON string counts, as in signalsOfStep (->> would turn a number into text).
  const stringAt = (key: string): SQL<string | null> =>
    sql<string | null>`CASE WHEN ${nodeType} IN (${types})
      THEN CASE WHEN jsonb_typeof(${output}->${literal(key)}) = 'string'
        THEN ${output}->>${literal(key)} END END`;
  return {
    route: stringAt(RUN_OUTCOME_OUTPUT.routeKey),
    notIncludedReason: stringAt(RUN_OUTCOME_OUTPUT.notIncludedReasonKey),
  };
}
