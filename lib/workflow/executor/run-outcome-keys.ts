// No imports: the step code, the editor and discover-plugins load these keys
// before any file is generated. The read-only list lives in step-signals.ts.

/** The output keys a step sets the run outcome with, shared by the TS and SQL readers. */
export const RUN_OUTCOME_OUTPUT = {
  routeKey: "route",
  skippedInFlightRoute: "skipped-in-flight",
  // Not before is still too far ahead: the step sent nothing.
  waitingRoute: "waiting",
  notIncludedReasonKey: "notIncludedReason",
} as const;

/** Only Write Contract (and its legacy name) sends bundles, so only it may set the outcome. */
export const BUNDLE_STEP_ACTION_TYPES: readonly string[] = [
  "web3/write-contract",
  "Write Contract",
];

/** Where a bundle step's write went: sent as a bundle. */
export const BUNDLE_ROUTE = "bundle" as const;

/** Output keys that show a step sent or paid for something; an allowed step must carry none. */
export const SENT_OUTPUT_KEYS = ["transactionHash", "gasUsed"] as const;

/**
 * How a Write Contract result ends its value reservation. Skipped in flight
 * and waiting moved nothing: released, as is a failure before sending or a mined revert.
 * A miss is held: no builder picked it, none accepted it (each still read its
 * signed bytes), or the step stopped waiting for it. Its signed transactions
 * can still be mined until the nonce is used, and the cap counts it by its
 * recorded nonce (value-ledger). A nonce used elsewhere is held too, but its
 * row is confirmed with the other transaction, so it counts 0. Every other
 * success keeps its charge.
 */
export function bundleReservationEnd(result: {
  success: boolean;
  route?: string;
  included?: boolean;
  broadcastAttempted?: boolean;
  notIncludedReason?: string;
}): "settle" | "release" | "hold" {
  const sentNotIncluded =
    result.route === BUNDLE_ROUTE && result.included === false;
  if (!result.success) {
    return sentNotIncluded && result.broadcastAttempted === true
      ? "hold"
      : "release";
  }
  if (
    result.route === RUN_OUTCOME_OUTPUT.skippedInFlightRoute ||
    result.route === RUN_OUTCOME_OUTPUT.waitingRoute
  ) {
    return "release";
  }
  const decidedMiss =
    sentNotIncluded &&
    result.notIncludedReason !== undefined &&
    result.notIncludedReason !== "not-checked";
  return decidedMiss ? "hold" : "settle";
}

/** What the run's steps said, merged over every successful step. */
export type RunOutcomeSignals = {
  skippedInFlight: boolean;
  notIncluded: boolean;
  // A bundle step sent nothing because Not before was still too far ahead.
  waiting: boolean;
  // A bundle step sent a bundle: its landing or miss wins over waiting.
  bundleSent: boolean;
  // A step other than the trigger, a read-only step or a waiting bundle step ran.
  otherWork: boolean;
};

export const NO_RUN_OUTCOME_SIGNALS: RunOutcomeSignals = {
  skippedInFlight: false,
  notIncluded: false,
  waiting: false,
  bundleSent: false,
  otherWork: false,
};

/** A step output's fields when it is an object, else undefined. */
export function fieldsOf(output: unknown): Record<string, unknown> | undefined {
  return output === null || typeof output !== "object" || Array.isArray(output)
    ? undefined
    : (output as Record<string, unknown>);
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

/** The bundle signals; otherWork is step-signals' call. */
type BundleSignals = Omit<RunOutcomeSignals, "otherWork">;

const NO_BUNDLE_SIGNALS: BundleSignals = {
  skippedInFlight: false,
  notIncluded: false,
  waiting: false,
  bundleSent: false,
};

/** The bundle signals one successful step's output carries (otherWork: see step-signals). */
export function bundleSignalsOfStep(
  nodeType: string,
  output: unknown
): BundleSignals {
  const fields = fieldsOf(output);
  if (!(BUNDLE_STEP_ACTION_TYPES.includes(nodeType) && fields)) {
    return NO_BUNDLE_SIGNALS;
  }
  const reason = fields[RUN_OUTCOME_OUTPUT.notIncludedReasonKey];
  const route = fields[RUN_OUTCOME_OUTPUT.routeKey];
  return {
    skippedInFlight: route === RUN_OUTCOME_OUTPUT.skippedInFlightRoute,
    notIncluded: typeof reason === "string" && hasVisibleText(reason),
    waiting: route === RUN_OUTCOME_OUTPUT.waitingRoute,
    bundleSent: route === BUNDLE_ROUTE,
  };
}

/** How a run view shows a successful Write Contract step that sent no transaction that landed in time. */
export type StepOutcome =
  | "not-included"
  | "skipped-in-flight"
  | "landed-late"
  | "landed-late-reverted";

type HashEntry = {
  nodeId?: string;
  iterationIndex?: number | null;
  receiptStatus?: string;
};

/**
 * The one rule for a step's shown outcome, as the finalizer reads its output.
 * A missed step whose run re-settled (a late hash names it, or the run is
 * success, which a miss alone never is) landed late; reverted if that hash did.
 */
export function stepOutcomeOf(
  step: {
    nodeId: string;
    nodeType: string;
    status: string;
    output: unknown;
    iterationIndex?: number | null;
  },
  run?: {
    status: string;
    transactionHashes?: readonly HashEntry[] | null;
  }
): StepOutcome | undefined {
  if (step.status !== "success") {
    return;
  }
  const signals = bundleSignalsOfStep(step.nodeType, step.output);
  if (signals.skippedInFlight) {
    return "skipped-in-flight";
  }
  if (!signals.notIncluded) {
    return;
  }
  const iteration = step.iterationIndex ?? null;
  const lateHash = (run?.transactionHashes ?? []).find(
    (entry) =>
      entry.nodeId === step.nodeId &&
      (entry.iterationIndex ?? null) === iteration
  );
  if (lateHash?.receiptStatus === "reverted") {
    return "landed-late-reverted";
  }
  return lateHash || run?.status === "success" ? "landed-late" : "not-included";
}

/** A node's outcome in the status endpoint: a step outcome, or waiting for Not before. */
export type NodeOutcome = StepOutcome | "waiting";

/** The status endpoint's outcome for a step: stepOutcomeOf, else waiting when the step waited. */
export function nodeOutcomeOf(
  step: Parameters<typeof stepOutcomeOf>[0],
  run?: Parameters<typeof stepOutcomeOf>[1]
): NodeOutcome | undefined {
  const outcome = stepOutcomeOf(step, run);
  if (outcome || step.status !== "success") {
    return outcome;
  }
  return bundleSignalsOfStep(step.nodeType, step.output).waiting
    ? "waiting"
    : undefined;
}

/** Each outcome's label and sentence, shared by the canvas and the Runs panel. */
export const STEP_OUTCOME_TEXT: Readonly<
  Record<StepOutcome, { label: string; sentence: string }>
> = {
  "not-included": {
    label: "Not included",
    sentence: "this step's bundle was not seen in any of its target blocks.",
  },
  "skipped-in-flight": {
    label: "Skipped",
    sentence:
      "an earlier bundle from this workflow could still land, so this step sent nothing; no gas was paid.",
  },
  "landed-late": {
    label: "Landed late",
    sentence:
      "this step's bundle was not seen in its target blocks, but its transaction was mined later and paid gas.",
  },
  "landed-late-reverted": {
    label: "Reverted late",
    sentence:
      "this step's bundle was not seen in its target blocks; its transaction was mined later, reverted, and still paid gas.",
  },
};

/** A step outcome's tooltip: label, sentence, then the extra words a view adds. */
export function stepOutcomeTitle(
  outcome: StepOutcome,
  ...extra: (string | undefined)[]
): string {
  const { label, sentence } = STEP_OUTCOME_TEXT[outcome];
  return [`${label}: ${sentence}`, ...extra].filter(Boolean).join(" ");
}

// The not landed note's pointer to the step, dropped where the step reasons are listed.
export const NOT_LANDED_STEP_POINTER = "; the Write Contract step says why.";

/** The short reason a not landed or skipped run carries in `error`. */
export const RUN_OUTCOME_REASON = {
  skipped:
    "Skipped: this workflow's earlier bundle could still land, so the bundle step sent no transaction.",
  waiting:
    "Waiting: a bundle step's Not before time is still too far ahead, so it sent no transaction; no gas was paid.",
  // Other steps ran too, so the run is billed; this names the waiting step only.
  waitingWithOtherSteps:
    "Waiting: a bundle step's Not before time is still too far ahead, so that step sent no transaction. It counts as a run because other steps did work.",
  not_landed: `Not landed: a bundle in this run was not seen in any of the blocks it was sent for (or could not be checked). No gas is paid for a bundle that does not land${NOT_LANDED_STEP_POINTER}`,
} as const;

/** A not landed run's reason once one of its bundles was mined later (and paid gas). */
export const NOT_LANDED_PARTLY_REASON = `Not landed: a bundle in this run was not seen in any of the blocks it was sent for (or could not be checked). Some of its bundles were mined later and paid gas, and any still missing may yet land${NOT_LANDED_STEP_POINTER}`;

/** Each notIncludedReason in plain words, for run views and alerts. */
export const NOT_INCLUDED_REASON_TEXT: Readonly<Record<string, string>> = {
  "not-picked":
    "No builder included it, though the call would still have worked; no gas was paid. A higher tip (Priority Fee or the tip increase) or more builders can help.",
  "no-longer-needed":
    "The call would now fail, most likely because someone else made it first; no gas was paid.",
  "not-checked":
    "It could not be checked yet, and it may still land within about a day.",
};

/** The plain sentence for a step output's notIncludedReason, if it has a known one. */
export function notIncludedReasonText(output: unknown): string | undefined {
  if (typeof output !== "object" || output === null) {
    return;
  }
  const reason = (output as Record<string, unknown>)[
    RUN_OUTCOME_OUTPUT.notIncludedReasonKey
  ];
  return typeof reason === "string"
    ? NOT_INCLUDED_REASON_TEXT[reason]
    : undefined;
}

/** The stable key a skipped run stores in `errorCode` when a bundle step waited for Not before. */
export const RUN_OUTCOME_CODE = {
  // Only the trigger, read-only steps and the waiting step ran: not billed.
  waiting: "bundle-waiting",
  // Other steps ran too: billed.
  waitingWithOtherSteps: "bundle-waiting-other-steps",
} as const;

export type RunOutcomeCode =
  (typeof RUN_OUTCOME_CODE)[keyof typeof RUN_OUTCOME_CODE];

/** The reason a run skipped because the previous one was still running carries. */
export const SKIPPED_WHILE_RUNNING_REASON =
  "Execution skipped: the previous run of this workflow was still running.";

/**
 * Why a skipped run was skipped, as a stable key the runs list returns
 * (`skipReason`), so a view can group runs in a row with the same one.
 */
export const SKIP_REASON = {
  bundleInFlight: "bundle-in-flight",
  bundleWaiting: "bundle-waiting",
  whileRunning: "while-running",
} as const;

export type SkipReason = (typeof SKIP_REASON)[keyof typeof SKIP_REASON];

type SkippedRow = {
  status: string;
  error: string | null | undefined;
  errorCode?: string | null;
};

// The code; rows stored before it fall back to the exact reason text.
function waitingCodeOf(run: SkippedRow): RunOutcomeCode | undefined {
  if (run.errorCode === RUN_OUTCOME_CODE.waiting) {
    return RUN_OUTCOME_CODE.waiting;
  }
  if (run.errorCode === RUN_OUTCOME_CODE.waitingWithOtherSteps) {
    return RUN_OUTCOME_CODE.waitingWithOtherSteps;
  }
  if (run.errorCode == null && run.error === RUN_OUTCOME_REASON.waiting) {
    return RUN_OUTCOME_CODE.waiting;
  }
  return;
}

/**
 * The skip reason key of a run row; null when none applies. Only a run that
 * waited and ran nothing else is a waiting run: one that ran other steps is not grouped.
 */
export function skipReasonOf(run: SkippedRow): SkipReason | null {
  if (run.status !== "skipped") {
    return null;
  }
  const waiting = waitingCodeOf(run);
  if (waiting) {
    return waiting === RUN_OUTCOME_CODE.waiting
      ? SKIP_REASON.bundleWaiting
      : null;
  }
  if (run.error === RUN_OUTCOME_REASON.skipped) {
    return SKIP_REASON.bundleInFlight;
  }
  return run.error === SKIPPED_WHILE_RUNNING_REASON
    ? SKIP_REASON.whileRunning
    : null;
}

/** Whether a finished run is not billed: Skipped only because a bundle step waited, with nothing else run. */
export function isUnbilledOutcome(
  status: string,
  errorCode: string | null | undefined,
  error: string | null | undefined
): boolean {
  return (
    status === "skipped" &&
    waitingCodeOf({ status, errorCode, error }) === RUN_OUTCOME_CODE.waiting
  );
}

/** The metrics reason label of a skipped run, from its code and `error`. */
export function skippedMetricReason(
  errorCode: string | null | undefined,
  error: string | null | undefined
): "bundle_in_flight" | "bundle_waiting" {
  return waitingCodeOf({ status: "skipped", errorCode, error })
    ? "bundle_waiting"
    : "bundle_in_flight";
}

/** What a step that ended waiting shows: label and sentence, for the run views. */
export const WAITING_STEP_TEXT = {
  label: "Waiting",
  sentence:
    "Not before is still too far ahead, so this step sent nothing; no gas was paid. A later run sends once the first allowed block is close enough.",
} as const;

// The skip reason planTips gives a target whose projected base fee is above Max Fee.
const MAX_FEE_SKIP_REASON = "max-fee-below-projected-base-fee";

/** Why a waiting step sent nothing: Not before, or a Max Fee that held back every target ahead. */
export function waitingStepSentence(output: unknown): string {
  const skipped =
    typeof output === "object" && output !== null
      ? (output as { bundleTargetsSkipped?: unknown }).bundleTargetsSkipped
      : undefined;
  const feeHeld =
    Array.isArray(skipped) &&
    skipped.some(
      (target: unknown) =>
        (target as { reason?: unknown } | null)?.reason === MAX_FEE_SKIP_REASON
    );
  return feeHeld
    ? "Max Fee held back the targets ahead, so this step sent nothing (no gas was paid); raise Max Fee if it keeps waiting."
    : WAITING_STEP_TEXT.sentence;
}
