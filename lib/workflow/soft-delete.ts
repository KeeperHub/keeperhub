import { isNull, type SQL } from "drizzle-orm";
import { workflows } from "@/lib/db/schema";

/**
 * KEEP-440: Drizzle predicate that excludes soft-deleted workflow rows.
 *
 * Workflows are soft-deleted (`deletedAt` set) instead of hard-deleted so the
 * listed slug stays bound to the row and cannot be re-claimed by another
 * workflow. Every read that should treat a deleted workflow as gone must
 * compose this into its WHERE clause. The owner-facing workflow list is the
 * deliberate exception -- it keeps showing deleted rows so the UI can mark
 * them as deleted.
 */
export function workflowNotDeleted(): SQL {
  return isNull(workflows.deletedAt);
}

/** KEEP-440: true when a fetched workflow row has been soft-deleted. */
export function isWorkflowDeleted(workflow: {
  deletedAt: Date | null;
}): boolean {
  return workflow.deletedAt !== null;
}

/**
 * KEEP-440: the column writes that retire a workflow. `deletedAt` records the
 * soft-delete; `isListed: false` drops it off every marketplace surface (and
 * is the secondary guard a few read paths still lean on). Every retirement
 * path -- the delete handler and the duplicate-route anonymous move -- writes
 * this same shape so a workflow is never left half-retired.
 */
export function softDeleteValues(): {
  deletedAt: Date;
  isListed: boolean;
  shareExecutionStatus: boolean;
} {
  return {
    deletedAt: new Date(),
    isListed: false,
    shareExecutionStatus: false,
  };
}

/**
 * Filter the owner-facing workflow list down to entries that belong in the
 * sidebar picker. Soft-deleted rows are dropped (audit/recovery still keeps
 * them in the API payload for other surfaces) and the internal `__current__`
 * stub is excluded. Disabled rows are intentionally kept -- the picker greys
 * them out and tags them rather than hiding them.
 */
export function filterPickerVisible<
  T extends { name: string; deletedAt?: Date | string | null },
>(entries: T[]): T[] {
  return entries.filter(
    // `== null` matches both null and undefined without coercing the
    // `Date | string` arms, which would mis-handle a `new Date(0)` or "".
    (entry) => entry.name !== "__current__" && entry.deletedAt == null
  );
}
