import {
  isEnabledForOrg,
  isRolloutActive,
  splitByRollout as splitRows,
} from "@/lib/rollout";

/** FAILURE_ALERTS_ROLLOUT, parsed by the shared rollout parser. */
export function isFailureAlertsEnabledForOrg(
  organizationId: string,
  rollout: string | undefined = process.env.FAILURE_ALERTS_ROLLOUT
): boolean {
  return isEnabledForOrg(organizationId, rollout);
}

export function splitByRollout<T>(
  rows: T[],
  orgOf: (row: T) => string | undefined,
  rollout: string | undefined = process.env.FAILURE_ALERTS_ROLLOUT
): { kept: T[]; dropped: T[] } {
  return splitRows(rows, orgOf, rollout);
}

export function isFailureAlertsRolloutActive(
  rollout: string | undefined = process.env.FAILURE_ALERTS_ROLLOUT
): boolean {
  return isRolloutActive(rollout);
}
