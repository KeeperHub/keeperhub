// Display only: back-to-back runs that waited for the same Not before share one
// Runs panel row. Each run stays its own stored run.
import { ACTIVE_RUN_STATUSES } from "@/lib/errors/execution-status";
import {
  formatDateTimeWithZone,
  formatShortTime,
} from "@/lib/web3/unix-time-display";
import {
  SKIP_REASON,
  type SkipReason,
} from "@/lib/workflow/executor/run-outcome-keys";
import type { WaitingRunInfo } from "@/lib/workflow/executor/waiting-runs";

export type GroupableRun = {
  id: string;
  startedAt: Date | string;
  skipReason?: SkipReason | null;
  waiting?: WaitingRunInfo | null;
  // A skipped-while-running row's count of folded dispatches.
  refusals?: number | null;
  // Runs of different workflows never share a row (the Analytics table lists several).
  workflowId?: string | null;
  // A same-workflow run still active may yet end waiting, so it does not anchor a row's key.
  status?: string | null;
};

/** One row of the list: a run with its number, or a group of waiting runs. */
export type RunListEntry<T extends GroupableRun> =
  | { kind: "run"; run: T; number: number }
  | {
      kind: "waiting";
      // The row's React key and open state: Not before and the nearest newer settled
      // run outside it, so neither Load more nor a run joining at the top changes it.
      stateKey: string;
      // The waiting runs, newest first, as listed.
      runs: T[];
      // Skipped-while-running rows between two of its waiting runs.
      skippedWhileRunning: T[];
      newestNumber: number;
      oldestNumber: number;
      notBefore: number | null;
    };

export type WaitingGroup<T extends GroupableRun> = Extract<
  RunListEntry<T>,
  { kind: "waiting" }
>;

const ACTIVE_STATUSES: ReadonlySet<string> = new Set(ACTIVE_RUN_STATUSES);

function isWaiting(run: GroupableRun): boolean {
  return run.skipReason === SKIP_REASON.bundleWaiting;
}

/** Whether a run above a group may still join it: same workflow, and unsettled or a skip while running. */
function mayJoin(run: GroupableRun, member: GroupableRun): boolean {
  // Runs panel rows all share one workflowId; a list that leaves it out matches undefined to undefined.
  return (
    run.workflowId === member.workflowId &&
    (ACTIVE_STATUSES.has(run.status ?? "") ||
      run.skipReason === SKIP_REASON.whileRunning)
  );
}

/** Not before and the nearest newer run that settled outside the group ("top" if none). */
function stateKeyOf(
  runs: readonly GroupableRun[],
  index: number,
  notBefore: number | null
): string {
  const run = runs[index];
  if (notBefore === null) {
    return run.id;
  }
  const newer = runs.slice(0, index).findLast((above) => !mayJoin(above, run));
  return `not-before:${notBefore}:after:${newer?.id ?? "top"}`;
}

/**
 * The list's rows, newest first. A run is numbered `total - index`. Waiting
 * runs next to each other with the same Not before share one row, with any
 * skipped-while-running rows between them; any other run, or another Not
 * before, starts a new row.
 */
export function groupWaitingRuns<T extends GroupableRun>(
  runs: readonly T[],
  total: number
): RunListEntry<T>[] {
  const entries: RunListEntry<T>[] = [];
  // Skipped-while-running rows after a waiting row, joined only if a matching waiting run follows.
  let held: { run: T; number: number }[] = [];
  const release = (): void => {
    for (const entry of held) {
      entries.push({ kind: "run", ...entry });
    }
    held = [];
  };
  for (const [index, run] of runs.entries()) {
    const number = total - index;
    const last = entries.at(-1);
    const sameWorkflow =
      last?.kind === "waiting" && last.runs[0].workflowId === run.workflowId;
    if (
      run.skipReason === SKIP_REASON.whileRunning &&
      last?.kind === "waiting" &&
      sameWorkflow &&
      last.notBefore !== null
    ) {
      held.push({ run, number });
      continue;
    }
    if (!isWaiting(run)) {
      release();
      entries.push({ kind: "run", run, number });
      continue;
    }
    const notBefore = run.waiting?.notBefore ?? null;
    if (
      last?.kind === "waiting" &&
      sameWorkflow &&
      notBefore !== null &&
      last.notBefore === notBefore
    ) {
      last.skippedWhileRunning.push(...held.map((entry) => entry.run));
      held = [];
      last.runs.push(run);
      last.oldestNumber = number;
      continue;
    }
    release();
    entries.push({
      kind: "waiting",
      stateKey: stateKeyOf(runs, index, notBefore),
      runs: [run],
      skippedWhileRunning: [],
      newestNumber: number,
      oldestNumber: number,
      notBefore,
    });
  }
  release();
  return entries;
}

// `numbered: false` leaves run numbers out, where a list does not number runs.
type TextOptions = { now: Date; timeZone?: string; numbered?: boolean };

const PAYG_NOT_REFUNDED =
  "Pay-as-you-go charges taken when a run starts are not refunded.";

/** Where the read-only list is, as the billing line names it. */
export const READ_ONLY_LIST_PLACE = "Billing in the Web3 docs";

/** What a waiting run costs, as the editor hint and the Analytics tooltips say it. */
export const WAITING_BILLING_TEXT = `A waiting run whose other steps are all on the read-only list (${READ_ONLY_LIST_PLACE}) does not count toward your plan's runs. ${PAYG_NOT_REFUNDED}`;

/** Which skipped runs count, for the Analytics Skipped tooltips; the waiting run's line follows. */
export const SKIPPED_BILLING_TEXT = `Most skipped runs do not count toward your plan's runs; a run skipped because an earlier run's bundle was in flight does, and so does a waiting run with a step off the read-only list. ${WAITING_BILLING_TEXT}`;

// A waiting row holds only runs that ran nothing else, so it can say it plainly.
function waitingGroupBillingText(runs: number): string {
  const subject = runs === 1 ? "This run does" : "These runs do";
  return `${subject} not count toward your plan's runs. ${PAYG_NOT_REFUNDED}`;
}

function secondsOf(value: Date | string): number {
  return Math.floor(new Date(value).getTime() / 1000);
}

function count(value: number): string {
  return value.toLocaleString("en-US");
}

/** How many dispatches the group's skipped-while-running rows stand for. */
export function skippedWhileRunningCount(
  group: WaitingGroup<GroupableRun>
): number {
  return group.skippedWhileRunning.reduce(
    (sum, run) => sum + Math.max(1, run.refusals ?? 1),
    0
  );
}

// "12 skipped while running (2 runs)": the skips, and the runs holding them when fewer, so the run range adds up.
function skippedPart(group: WaitingGroup<GroupableRun>): string {
  const runs = group.skippedWhileRunning.length;
  if (runs === 0) {
    return "";
  }
  const skips = skippedWhileRunningCount(group);
  const shown =
    skips > runs ? ` (${count(runs)} ${runs === 1 ? "run" : "runs"})` : "";
  return `, ${count(skips)} skipped while running${shown}`;
}

/** The row's chip: "37 waiting", the count first; skips while running are in the range text. */
export function waitingChipText(
  group: WaitingGroup<GroupableRun>,
  label = "waiting"
): string {
  return `${count(group.runs.length)} ${label}`;
}

/** The row's second line: "not before 13:00", with the date when it is not today. */
export function waitingRowLine(
  group: WaitingGroup<GroupableRun>,
  options: TextOptions
): string {
  return group.notBefore === null
    ? "waiting for Not before"
    : `not before ${formatShortTime(group.notBefore, options)}`;
}

function runSpan(
  group: WaitingGroup<GroupableRun>,
  options: TextOptions
): string {
  const newest = group.runs[0];
  const oldest = group.runs.at(-1) ?? newest;
  const at = (run: GroupableRun) =>
    formatShortTime(secondsOf(run.startedAt), {
      ...options,
      withSeconds: true,
    });
  const numbered = options.numbered !== false;
  if (group.runs.length === 1) {
    return numbered
      ? `One run, #${group.newestNumber}, at ${at(newest)}`
      : `One run, at ${at(newest)}`;
  }
  const numbers = numbered
    ? `, #${group.oldestNumber} to #${group.newestNumber}`
    : "";
  return `${count(group.runs.length)} waiting${skippedPart(group)}${numbers}, from ${at(oldest)} to ${at(newest)}`;
}

/** The row's tooltip: the count, the run range and the full Not before with its zone. */
export function waitingRowTitle(
  group: WaitingGroup<GroupableRun>,
  options: TextOptions
): string {
  const time =
    group.notBefore === null
      ? ""
      : `: ${formatDateTimeWithZone(group.notBefore, options)}`;
  return `Skipped, waiting for Not before${time}. ${runSpan(group, options)}.`;
}

function blocks(value: number): string {
  return `${count(value)} ${value === 1 ? "block" : "blocks"}`;
}

/** What the expanded row says, one sentence group per line. */
export function waitingDetails(
  group: WaitingGroup<GroupableRun>,
  options: TextOptions
): string[] {
  const time =
    group.notBefore === null
      ? "Waiting for Not before."
      : `Waiting for Not before: ${formatDateTimeWithZone(group.notBefore, options)}.`;
  const lines = [
    `${time} The Write Contract step sent nothing and did not touch the wallet.`,
    `${runSpan(group, options)}${group.runs.length === 1 ? "" : ", shown as one row"}. Waiting runs end Skipped and do not count as failures.`,
    waitingGroupBillingText(group.runs.length),
  ];
  // The latest run's view of the chain: the newest first allowed block and head.
  const info = group.runs[0]?.waiting;
  if (info?.firstAllowedBlock != null && info.latestBlock != null) {
    const away = Math.max(0, info.firstAllowedBlock - info.latestBlock);
    let ahead = "";
    if (info.sendAheadBlocks === 0) {
      ahead = " The step sends once it is the next block (Send ahead 0).";
    } else if (info.sendAheadBlocks != null) {
      ahead = ` The step sends ${blocks(info.sendAheadBlocks)} before it (Send ahead).`;
    }
    lines.push(
      `First allowed block ${count(info.firstAllowedBlock)}, ${blocks(away)} away.${ahead}`
    );
  }
  return lines;
}
