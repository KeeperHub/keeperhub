// The executor's refusal texts for a run it will not start. Client-safe.

import type { LoadWorkflowForExecutionResult } from "./load-for-execution";

export type NotExecutableReason = Extract<
  LoadWorkflowForExecutionResult,
  { status: "not_executable" }
>["reason"];

/** True when the state can end (turned back on, un-halted): its old refusals then stop counting. */
const ENDS: Record<NotExecutableReason, boolean> = {
  deleted: true,
  deactivated: true,
  org_deactivated: true,
  halted: true,
  disabled: true,
  anonymous_owner: false,
};

export const NOT_EXECUTABLE_REASONS = Object.keys(
  ENDS
) as NotExecutableReason[];

export const WORKFLOW_NOT_FOUND_REFUSAL =
  "Execution skipped: workflow not found.";

const SCHEDULE_INVALID_TEXT = "schedule is disabled or no longer exists";
export const SCHEDULE_INVALID_REFUSAL = `Execution skipped: ${SCHEDULE_INVALID_TEXT}.`;

/** The run's stored error when the workflow is not executable. */
export function notExecutableRefusal(reason: NotExecutableReason): string {
  return `Execution skipped: workflow is not executable (${reason}).`;
}

const codes = (reasons: NotExecutableReason[]): string =>
  `not executable \\((${reasons.join("|")})\\)`;

/** A stored "not executable (<code>)" refusal; group 1 is the code. */
export const NOT_EXECUTABLE_CODE = new RegExp(codes(NOT_EXECUTABLE_REASONS));

/** Refusals for a state that ended no longer count (a POSIX regex for SQL). */
export const STATE_REFUSAL_PATTERN = `${codes(
  NOT_EXECUTABLE_REASONS.filter((reason) => ENDS[reason])
)}|${SCHEDULE_INVALID_TEXT}`;

const CANNOT_RUN = new RegExp(
  `not executable \\(|${SCHEDULE_INVALID_TEXT}|workflow not found`
);

/** Refused because the workflow or schedule cannot run (stored or shown text), not for plan or billing. */
export function refusalCannotRun(reason: string | null): boolean {
  return reason !== null && CANNOT_RUN.test(reason);
}
