import { type AnyColumn, type SQL, sql } from "drizzle-orm";
import {
  BUNDLE_ROUTES,
  BUNDLE_STEP_ACTION_TYPES,
  isUnbilledOutcome,
  RUN_OUTCOME_CODE,
  RUN_OUTCOME_OUTPUT,
  RUN_OUTCOME_REASON,
  type RunOutcomeCode,
  type RunOutcomeSignals,
  SENT_OUTPUT_KEYS,
} from "./run-outcome-keys";
import { READ_ONLY_STEP_TYPES } from "./step-signals";

export {
  NO_RUN_OUTCOME_SIGNALS,
  type RunOutcomeSignals,
  skippedMetricReason,
} from "./run-outcome-keys";
export { isOtherWorkStep, signalsOfStep } from "./step-signals";

/**
 * A finished run that would be a success but is not: a bundle in it did not
 * land (`not_landed`), or a bundle step sent nothing because an earlier run's
 * bundle was still in flight (`skipped`, even when other steps sent) or Not
 * before was too far ahead (`skipped`, unless another bundle step sent).
 */
export type RunOutcome = "skipped" | "not_landed";

export function mergeSignals(
  a: RunOutcomeSignals,
  b: RunOutcomeSignals
): RunOutcomeSignals {
  return {
    skippedInFlight: a.skippedInFlight || b.skippedInFlight,
    ...((a.skippedPublicCopy === true || b.skippedPublicCopy === true) && {
      skippedPublicCopy: true,
    }),
    notIncluded: a.notIncluded || b.notIncluded,
    waiting: a.waiting || b.waiting,
    bundleSent: a.bundleSent || b.bundleSent,
    otherWork: a.otherWork || b.otherWork,
  };
}

export function hasSignal(signals: RunOutcomeSignals): boolean {
  return (
    signals.skippedInFlight ||
    signals.notIncluded ||
    signals.waiting ||
    signals.bundleSent ||
    signals.otherWork
  );
}

/**
 * The outcome of a run that would otherwise be a success. A bundle that may
 * still land wins; a skip in flight is `skipped` whatever other steps sent;
 * waiting is `skipped` unless another bundle step sent (its landing or miss shows).
 */
export function runOutcomeOf(
  signals: RunOutcomeSignals
): RunOutcome | undefined {
  if (signals.notIncluded) {
    return "not_landed";
  }
  if (signals.skippedInFlight || (signals.waiting && !signals.bundleSent)) {
    return "skipped";
  }
  return;
}

/** The stable code a run with this outcome stores in `errorCode`; null unless it waited. */
export function runOutcomeCode(
  outcome: RunOutcome,
  signals: RunOutcomeSignals
): RunOutcomeCode | null {
  if (outcome !== "skipped" || signals.skippedInFlight || !signals.waiting) {
    return null;
  }
  return signals.otherWork
    ? RUN_OUTCOME_CODE.waitingWithOtherSteps
    : RUN_OUTCOME_CODE.waiting;
}

/**
 * The short reason a not landed or skipped run carries in `error`, so the
 * runs list says why. A skip in flight wins over waiting. A late landing that
 * settles the run clears it.
 */
export function runOutcomeReason(
  outcome: RunOutcome,
  signals: RunOutcomeSignals
): string {
  const code = runOutcomeCode(outcome, signals);
  // Same skip key and billing as a skip behind a bundle (skipReasonOf); only the words differ.
  if (outcome === "skipped" && signals.skippedPublicCopy === true) {
    return RUN_OUTCOME_REASON.skippedPublicCopy;
  }
  if (code === RUN_OUTCOME_CODE.waiting) {
    return RUN_OUTCOME_REASON.waiting;
  }
  if (code === RUN_OUTCOME_CODE.waitingWithOtherSteps) {
    return RUN_OUTCOME_REASON.waitingWithOtherSteps;
  }
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

/** A log row (any status) that did more than read: isOtherWorkStep in SQL, never NULL. */
export function otherWorkSql(log: LogColumns): SQL {
  // Constant bundle types as literals, as below; the generated read list as one bound text[].
  const bundleTypes = sql.join(BUNDLE_STEP_ACTION_TYPES.map(literal), sql`, `);
  const quietTypes = sql.param([
    ...BUNDLE_STEP_ACTION_TYPES,
    ...READ_ONLY_STEP_TYPES,
  ]);
  const sent = sql.join(
    SENT_OUTPUT_KEYS.map(
      (key) => sql`coalesce(${log.outputRaw}->>${literal(key)}, '') <> ''`
    ),
    sql` OR `
  );
  const waiting = sql`coalesce(${log.outputRaw}->>${literal(RUN_OUTCOME_OUTPUT.routeKey)}, '') = ${literal(RUN_OUTCOME_OUTPUT.waitingRoute)}`;
  // The type first: most steps are neither, and then the output is never read.
  return sql`(CASE WHEN ${log.nodeType} <> ALL(${quietTypes}::text[]) THEN true
    ELSE (${sent} OR (${log.nodeType} IN (${bundleTypes}) AND NOT ${waiting})) END)`;
}

type RunColumns = {
  status: AnyColumn;
  error: AnyColumn;
  errorCode: AnyColumn;
  billable: AnyColumn;
};

/**
 * `billable` for a run row a settle moves to `next`: false for a run that only
 * waited; true again for a row that was one; else as it is (marketplace, refused).
 */
export function billableAfterSettle(
  run: RunColumns,
  next: {
    status: string;
    errorCode: string | null | undefined;
    error: string | null | undefined;
  }
): SQL | false {
  if (isUnbilledOutcome(next.status, next.errorCode, next.error)) {
    return false;
  }
  // Rare: a waiting row that was also marketplace-exempt turns billable here too (no marker kept).
  const wasWaiting = sql`(${run.status} = 'skipped' AND (${run.errorCode} = ${literal(RUN_OUTCOME_CODE.waiting)}
    OR (${run.errorCode} IS NULL AND ${run.error} = ${RUN_OUTCOME_REASON.waiting})))`;
  return sql`CASE WHEN ${wasWaiting} THEN true ELSE ${run.billable} END`;
}

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
  const bundleRoutes = sql.join(BUNDLE_ROUTES.map(literal), sql`, `);
  return {
    skippedInFlight: sql`(${writeContract}
      AND ${log.outputRaw}->>${route} = ${literal(RUN_OUTCOME_OUTPUT.skippedInFlightRoute)})`,
    skippedPublicCopy: sql`(${writeContract}
      AND ${log.outputRaw}->>${route} = ${literal(RUN_OUTCOME_OUTPUT.skippedInFlightRoute)}
      AND coalesce(jsonb_typeof(${log.outputRaw}->'inFlightHash') = 'string', false))`,
    notIncluded: sql`(${writeContract}
      AND jsonb_typeof(${log.outputRaw}->${reason}) = 'string'
      AND btrim(${log.outputRaw}->>${reason}, ${BLANK_CHARS_SQL}) <> '')`,
    waiting: sql`(${writeContract}
      AND ${log.outputRaw}->>${route} = ${literal(RUN_OUTCOME_OUTPUT.waitingRoute)})`,
    bundleSent: sql`(${writeContract}
      AND ${log.outputRaw}->>${route} IN (${bundleRoutes}))`,
    otherWork: otherWorkSql(log),
  };
}

/** Log rows that may carry a signal: a superset of the rows signalsOfStep reads one from. */
export function runOutcomeLogSql(log: LogColumns): SQL {
  const { skippedInFlight, notIncluded, waiting, bundleSent } =
    runOutcomeSignalSql(log);
  return sql`(${skippedInFlight} OR ${notIncluded} OR ${waiting} OR ${bundleSent})`;
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
  pending: SQL<boolean | null>;
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
    // Only a JSON true, as stepOutcomeOf reads it.
    pending: sql<boolean | null>`CASE WHEN ${nodeType} IN (${types})
      THEN ${output}->${literal(RUN_OUTCOME_OUTPUT.pendingKey)} = 'true'::jsonb END`,
  };
}
