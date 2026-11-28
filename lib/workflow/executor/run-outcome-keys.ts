// No imports: the step code that sets these keys loads without the SQL readers.

/** The output keys a step sets the run outcome with, shared by the TS and SQL readers. */
export const RUN_OUTCOME_OUTPUT = {
  routeKey: "route",
  skippedInFlightRoute: "skipped-in-flight",
  // Not before is still too far ahead: the step sent nothing.
  waitingRoute: "waiting",
  notIncludedReasonKey: "notIncludedReason",
  // A public copy was sent and is not mined yet.
  pendingKey: "pending",
} as const;

/** Only Write Contract (and its legacy name) sends bundles, so only it may set the outcome. */
export const BUNDLE_STEP_ACTION_TYPES: readonly string[] = [
  "web3/write-contract",
  "Write Contract",
];

// Where a bundle step's write went: sent as a bundle.
const BUNDLE_ROUTE = "bundle" as const;

// Sent as a bundle and publicly too: the route equals the mode.
const BUNDLE_AND_PUBLIC_ROUTE = "bundle-and-public" as const;

/** Every route a bundle step reports after sending; quote-free, the SQL reads them as literals. */
export const BUNDLE_ROUTES = [BUNDLE_ROUTE, BUNDLE_AND_PUBLIC_ROUTE] as const;

export type BundleSendRoute = (typeof BUNDLE_ROUTES)[number];

/** Whether a step's `route` says it sent a bundle; use this, never a compare with "bundle". */
export function isBundleRoute(route: unknown): route is BundleSendRoute {
  return (BUNDLE_ROUTES as readonly unknown[]).includes(route);
}

/**
 * How a Write Contract result ends its value reservation. Skipped in flight
 * and waiting moved nothing: released, as is a failure before sending or a mined revert.
 * A miss is held: no builder picked it, none accepted it (each still read its
 * signed bytes), or the step stopped waiting for it. Its signed transactions
 * can still be mined until the nonce is used, and the cap counts it by its
 * recorded nonce (value-ledger). A nonce used elsewhere is held too, but its
 * row is confirmed with the other transaction, so it counts 0. Every other
 * success keeps its charge, a public copy not mined yet included: the cap
 * counts its linked row by nonce, once (value-ledger), so no change is needed.
 */
export function bundleReservationEnd(result: {
  success: boolean;
  route?: string;
  included?: boolean;
  broadcastAttempted?: boolean;
  notIncludedReason?: string;
}): "settle" | "release" | "hold" {
  const sentNotIncluded =
    isBundleRoute(result.route) && result.included === false;
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
  // A skip in flight behind an earlier run's public copy (inFlightHash); set only when true.
  skippedPublicCopy?: boolean;
  notIncluded: boolean;
  // A bundle step sent nothing because Not before was still too far ahead.
  waiting: boolean;
  // A bundle step sent a bundle: its landing or miss wins over waiting.
  bundleSent: boolean;
};

export const NO_RUN_OUTCOME_SIGNALS: RunOutcomeSignals = {
  skippedInFlight: false,
  notIncluded: false,
  waiting: false,
  bundleSent: false,
};

/** A step output's fields when it is an object, else undefined. */
function fieldsOf(output: unknown): Record<string, unknown> | undefined {
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

/** The signals one successful step's output carries; none unless it is Write Contract. */
export function signalsOfStep(
  nodeType: string,
  output: unknown
): RunOutcomeSignals {
  const fields = fieldsOf(output);
  if (!(BUNDLE_STEP_ACTION_TYPES.includes(nodeType) && fields)) {
    return NO_RUN_OUTCOME_SIGNALS;
  }
  const reason = fields[RUN_OUTCOME_OUTPUT.notIncludedReasonKey];
  const route = fields[RUN_OUTCOME_OUTPUT.routeKey];
  const skippedInFlight = route === RUN_OUTCOME_OUTPUT.skippedInFlightRoute;
  return {
    skippedInFlight,
    ...(skippedInFlight &&
      typeof fields.inFlightHash === "string" && { skippedPublicCopy: true }),
    notIncluded: typeof reason === "string" && hasVisibleText(reason),
    waiting: route === RUN_OUTCOME_OUTPUT.waitingRoute,
    bundleSent: isBundleRoute(route),
  };
}

/** How a run view shows a successful Write Contract step that sent no transaction that landed in time. */
export type StepOutcome =
  | "not-included"
  | "skipped-in-flight"
  | "landed-late"
  | "landed-late-reverted"
  | "public-pending";

/** A bundle step that ended with its public copy sent and not mined yet. */
export function isPublicPendingStep(
  nodeType: string,
  output: unknown
): boolean {
  const fields = fieldsOf(output);
  return (
    BUNDLE_STEP_ACTION_TYPES.includes(nodeType) &&
    fields?.[RUN_OUTCOME_OUTPUT.pendingKey] === true &&
    isBundleRoute(fields[RUN_OUTCOME_OUTPUT.routeKey])
  );
}

type HashEntry = {
  nodeId?: string;
  iterationIndex?: number | null;
  receiptStatus?: string;
};

/**
 * The one rule for a step's shown outcome, as the finalizer reads its output.
 * A missed or pending step whose run re-settled landed late (reverted if that hash did).
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
  const signals = signalsOfStep(step.nodeType, step.output);
  if (signals.skippedInFlight) {
    return "skipped-in-flight";
  }
  const pending = isPublicPendingStep(step.nodeType, step.output);
  if (!(signals.notIncluded || pending)) {
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
  // A pending step's own hash is listed from the start, unread until it is mined.
  const landed = pending
    ? lateHash?.receiptStatus === "success"
    : lateHash !== undefined;
  if (landed || run?.status === "success") {
    return "landed-late";
  }
  return pending && (run === undefined || run.status === "unconfirmed")
    ? "public-pending"
    : "not-included";
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
  return signalsOfStep(step.nodeType, step.output).waiting
    ? "waiting"
    : undefined;
}

/** What every not-mined-yet text says: how the run settles, and that a mined copy is paid for. */
export const NOT_MINED_YET_TEXT =
  "is not mined yet; KeeperHub settles the run once it is mined or dropped. If it is mined, the wallet pays its gas, even if it reverts.";

/** Appended only where a public copy is known to be pending: its usual cause and fix. */
const PUBLIC_COPY_STUCK_TEXT =
  "If it stays unmined, most often its fee cap is below the base fee; it clears when the base fee falls back under it. KeeperHub does not replace it; raise Max Fee or leave it empty for later runs.";

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
  "public-pending": {
    label: "Unconfirmed",
    sentence: `this step's transaction was sent publicly and ${NOT_MINED_YET_TEXT} ${PUBLIC_COPY_STUCK_TEXT}`,
  },
};

/** Where no RPC answered clearly when the public copy was sent (accepted null). */
const NO_RPC_CONFIRMED = " (no RPC confirmed taking it)";

function publicCopyUnclear(output: unknown): boolean {
  const copy = fieldsOf(fieldsOf(output)?.publicCopy);
  return copy !== undefined && copy.accepted === null;
}

/** A pending step's sentence; it says so when no RPC confirmed taking the copy. */
export function publicPendingSentence(output: unknown): string {
  return publicCopyUnclear(output)
    ? `this step's transaction was sent publicly${NO_RPC_CONFIRMED} and ${NOT_MINED_YET_TEXT} ${PUBLIC_COPY_STUCK_TEXT}`
    : STEP_OUTCOME_TEXT["public-pending"].sentence;
}

/** An unconfirmed run's note, naming the pending copy's hash when a step output carries one. */
export function unconfirmedRunNote(outputs: readonly unknown[]): string {
  const pending = outputs
    .map(fieldsOf)
    .find(
      (fields) =>
        fields?.[RUN_OUTCOME_OUTPUT.pendingKey] === true &&
        typeof fields.transactionHash === "string"
    );
  if (!pending) {
    return `A transaction was sent and ${NOT_MINED_YET_TEXT}`;
  }
  const unclear = publicCopyUnclear(pending) ? NO_RPC_CONFIRMED : "";
  return `A transaction (${String(pending.transactionHash)}) was sent${unclear} and ${NOT_MINED_YET_TEXT} ${PUBLIC_COPY_STUCK_TEXT}`;
}

/** A skipped step's sentence; behind a public copy (inFlightHash) it names the copy. A run's note names "the bundle step". */
export function skippedStepSentence(
  output: unknown,
  subject: "this step" | "the bundle step" = "this step"
): string {
  const hash = fieldsOf(output)?.inFlightHash;
  return typeof hash === "string"
    ? `an earlier run's public copy (${hash}) is not mined yet, so ${subject} sent nothing; no gas was paid. KeeperHub checks it every few minutes and stops waiting after a day.`
    : STEP_OUTCOME_TEXT["skipped-in-flight"].sentence;
}

/** A skipped step's tooltip: its label and sentence. */
export function skippedStepTitle(output: unknown): string {
  return `${STEP_OUTCOME_TEXT["skipped-in-flight"].label}: ${skippedStepSentence(output)}`;
}

/** The skipped-in-flight output that names a public copy, if a step has one. */
export function skippedBehindPublicCopy(
  outputs: readonly unknown[]
): unknown | undefined {
  return outputs.find((output) => {
    const fields = fieldsOf(output);
    return (
      fields?.[RUN_OUTCOME_OUTPUT.routeKey] ===
        RUN_OUTCOME_OUTPUT.skippedInFlightRoute &&
      typeof fields.inFlightHash === "string"
    );
  });
}

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
  // Names the waiting step only: the run's other steps may have sent and paid gas.
  waiting:
    "Waiting: a bundle step's Not before time is still too far ahead, so that step sent no transaction and paid no gas.",
  // Behind an earlier run's public copy; grouped and billed as skipped above (skipReasonOf).
  skippedPublicCopy:
    "Skipped: an earlier run's public copy is not mined yet, so the bundle step sent no transaction.",
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
  "public-copy-dropped":
    "Its public copy was not found on any RPC for three checks, so KeeperHub treats it as dropped. Most often its fee cap was below the base fee, or an RPC rejected it (for example for too little balance): raise Max Fee or leave it empty, and check the wallet's balance. Nothing was mined, and the nonce is free for the wallet's next transaction.",
  "public-copy-replaced":
    "Another transaction from the wallet used its nonce first, so its public copy can no longer be mined; no gas was paid for it.",
};

/** A public copy's publicCopy.error values, all lower-case fragments. */
export const PUBLIC_COPY_ERRORS = {
  relay: "this step sends through a private relay",
  gate: "first allowed block not reached in the window",
  needed: "no longer needed",
  record: "it could not be recorded, so it was not sent",
  refused: "no public RPC could be reached or every RPC rejected it",
  nonceUsed: "another transaction holds this nonce",
} as const;

/** How a public copy that will not be mined ends its run: found on no RPC, or its nonce used by another transaction. */
export type PublicCopyEnd = "public-copy-dropped" | "public-copy-replaced";

/** A not landed run's reason when its public copy was dropped or replaced. */
export function publicCopyNotLandedReason(end: PublicCopyEnd): string {
  return `Not landed: a bundle in this run was not seen in any of the blocks it was sent for. ${NOT_INCLUDED_REASON_TEXT[end]}`;
}

/** For a public copy dropped from the mempools: the usual causes and what to change. */
export const PUBLIC_COPY_DROPPED_NEXT_STEP =
  "A public copy that no RPC knows any more ends Not landed too: most often its fee cap was below the base fee, or an RPC rejected it, so raise Max Fee or leave it empty, and check the wallet's balance.";

/** How the reconciler's error starts for a run whose transactions never appeared within a day. */
export const NEVER_MINED_RUN_ERROR =
  "Transactions were broadcast but never appeared on chain";

/** A pending step's line once its run gave up on it after a day. */
export const PUBLIC_COPY_EXPIRED_TEXT =
  "Its public copy was not mined within a day; it stays valid until the wallet's next transaction, and KeeperHub no longer watches it.";

/** Why a pending step's run settled without it: dropped, replaced, or a day passed; undefined otherwise. */
export function settledPendingReason(
  output: unknown,
  run: { status: string; error?: string | null }
): string | undefined {
  if (fieldsOf(output)?.[RUN_OUTCOME_OUTPUT.pendingKey] !== true) {
    return;
  }
  if (run.status === "not_landed") {
    const end: PublicCopyEnd = run.error?.includes(
      NOT_INCLUDED_REASON_TEXT["public-copy-replaced"]
    )
      ? "public-copy-replaced"
      : "public-copy-dropped";
    return NOT_INCLUDED_REASON_TEXT[end];
  }
  return run.status === "error" && run.error?.startsWith(NEVER_MINED_RUN_ERROR)
    ? PUBLIC_COPY_EXPIRED_TEXT
    : undefined;
}

/** Why a Bundle step's "Send publicly if still needed" fallback was not sent: the one list. */
export const FALLBACK_NOT_SENT_REASONS = [
  "no-longer-needed",
  "check-failed",
  "window-ending",
  "max-fee-below-base-fee",
  "not-checked",
  "no-builder-accepted",
  "first-allowed-block-not-reached",
  "no-public-rpc",
  "not-recorded",
  "refused",
  "nonce-used",
] as const;

export type FallbackNotSentReason = (typeof FALLBACK_NOT_SENT_REASONS)[number];

/** Each fallbackNotSentReason in plain words, added to a not landed run's reasons. */
export const FALLBACK_NOT_SENT_TEXT: Readonly<
  Record<FallbackNotSentReason, string>
> = {
  "no-longer-needed":
    "The public fallback was not sent: the call would now fail.",
  "check-failed":
    "The public fallback was not sent: the call could not be checked.",
  "window-ending":
    "The public fallback was not sent: too little of the bundle's window was left.",
  "max-fee-below-base-fee":
    "The public fallback was not sent: its fee cap was below the next block's base fee. Raise Max Fee or leave it empty.",
  "not-checked":
    "The public fallback was not sent: the bundle's outcome was still open.",
  "no-builder-accepted":
    "The public fallback was not sent: no builder accepted the bundle.",
  "first-allowed-block-not-reached":
    "The public fallback was not sent: the first allowed block was not reached in time.",
  "no-public-rpc":
    "The public fallback was not sent: the network's RPC for this step is a private relay, so there is nowhere public to send it.",
  "not-recorded":
    "The public fallback was not sent: it could not be recorded first.",
  refused:
    "The public fallback was not sent: no public RPC could be reached or every RPC rejected it (for example for too little balance).",
  "nonce-used":
    "The public fallback was not sent: another transaction holds this nonce.",
};

/** The plain sentence for a step output's fallbackNotSentReason, if it has a known one. */
export function fallbackNotSentText(output: unknown): string | undefined {
  const reason = fieldsOf(output)?.fallbackNotSentReason;
  return typeof reason === "string" &&
    Object.hasOwn(FALLBACK_NOT_SENT_TEXT, reason)
    ? FALLBACK_NOT_SENT_TEXT[reason as FallbackNotSentReason]
    : undefined;
}

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
  waiting: "bundle-waiting",
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

function isWaitingRow(run: SkippedRow): boolean {
  return run.errorCode === RUN_OUTCOME_CODE.waiting;
}

/** The skip reason key of a run row; null when none applies. */
export function skipReasonOf(run: SkippedRow): SkipReason | null {
  if (run.status !== "skipped") {
    return null;
  }
  if (isWaitingRow(run)) {
    return SKIP_REASON.bundleWaiting;
  }
  if (
    run.error === RUN_OUTCOME_REASON.skipped ||
    run.error === RUN_OUTCOME_REASON.skippedPublicCopy
  ) {
    return SKIP_REASON.bundleInFlight;
  }
  return run.error === SKIPPED_WHILE_RUNNING_REASON
    ? SKIP_REASON.whileRunning
    : null;
}

/** The metrics reason label of a skipped run, from its code and `error`. */
export function skippedMetricReason(
  errorCode: string | null | undefined,
  error: string | null | undefined
): "bundle_in_flight" | "bundle_waiting" {
  return isWaitingRow({ status: "skipped", errorCode, error })
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
