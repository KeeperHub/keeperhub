// No imports: the step code that sets these keys loads without the SQL readers.

/** The output keys a step sets the run outcome with, shared by the TS and SQL readers. */
export const RUN_OUTCOME_OUTPUT = {
  routeKey: "route",
  skippedInFlightRoute: "skipped-in-flight",
  notIncludedReasonKey: "notIncludedReason",
} as const;

/** Only Write Contract (and its legacy name) sends bundles, so only it may set the outcome. */
export const BUNDLE_STEP_ACTION_TYPES: readonly string[] = [
  "web3/write-contract",
  "Write Contract",
];

/** Where a bundle step's write went: sent as a bundle. */
export const BUNDLE_ROUTE = "bundle" as const;

/**
 * How a Write Contract result ends its value reservation. Skipped in flight
 * moved nothing: released. A decided miss is held: its signed transactions
 * can still be mined until the nonce is used, so it counts while its bundle
 * row says so. Every other success keeps its own charge, a replay's included:
 * the crashed attempt's reservation lapses, so the replay's must hold the value.
 */
export function bundleReservationEnd(result: {
  success: boolean;
  route?: string;
  included?: boolean;
  notIncludedReason?: string;
}): "settle" | "release" | "hold" {
  if (!result.success) {
    return "release";
  }
  if (result.route === RUN_OUTCOME_OUTPUT.skippedInFlightRoute) {
    return "release";
  }
  const decidedMiss =
    result.route === BUNDLE_ROUTE &&
    result.included === false &&
    result.notIncludedReason !== undefined &&
    result.notIncludedReason !== "not-checked";
  return decidedMiss ? "hold" : "settle";
}

/** What the run's steps said, merged over every successful step. */
export type RunOutcomeSignals = {
  skippedInFlight: boolean;
  notIncluded: boolean;
};

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
    !BUNDLE_STEP_ACTION_TYPES.includes(nodeType) ||
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
  const signals = signalsOfStep(step.nodeType, step.output);
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
  not_landed: `Not landed: a bundle in this run was not seen in any of the blocks it was sent for (or could not be checked). No gas is paid unless a bundle lands${NOT_LANDED_STEP_POINTER}`,
} as const;

/** A not landed run's reason once one of its bundles was mined later (and paid gas). */
export const NOT_LANDED_PARTLY_REASON = `Not landed: a bundle in this run was not seen in any of the blocks it was sent for (or could not be checked). Another bundle in it was mined later and paid gas; the rest may still land${NOT_LANDED_STEP_POINTER}`;

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
