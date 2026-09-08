/**
 * Workflow execution sharing flag helpers.
 *
 * shareExecutionStatus is an explicit owner opt-in (default false). It is
 * cleared on marketplace unlist and soft-delete so sharing never becomes
 * irreversible.
 *
 * The invariant every caller upholds: shareExecutionStatus === true implies
 * the workflow's visibility is public or unlisted. canShareExecutionStatus is
 * the single statement of that rule - the read gate
 * (lib/workflow/execution-access.ts), both write paths (the workflow PATCH
 * route and the curator listing API) and the listing overlay all defer to it,
 * so the client can never offer a state the server would not honour.
 */

/**
 * Whether a workflow at this visibility may have execution sharing enabled.
 *
 * Visibility, not isListed, is the gate: the two are independent axes, and a
 * marketplace-listed workflow can still be private. Sharing on a private
 * workflow is inert - the read gate refuses it and every link 404s - so
 * allowing it to be stored only produces owners who believe sharing is on.
 */
export function canShareExecutionStatus(
  visibility: string | null | undefined
): boolean {
  return visibility === "public" || visibility === "unlisted";
}

export function shareExecutionStatusUpdate(enabled: boolean): {
  shareExecutionStatus: boolean;
} {
  return { shareExecutionStatus: enabled };
}

export function clearShareExecutionStatus(): { shareExecutionStatus: false } {
  return { shareExecutionStatus: false };
}
