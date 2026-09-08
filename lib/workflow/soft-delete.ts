import { isNull, type SQL } from "drizzle-orm";
import { workflowExecutionLogs, workflows } from "@/lib/db/schema";

/**
 * KEEP-440: Drizzle predicate that excludes soft-deleted workflow rows.
 *
 * Workflows are soft-deleted (`deletedAt` set) instead of hard-deleted so the
 * listed slug stays bound to the row and cannot be re-claimed by another
 * workflow. Every read that should treat a deleted workflow as gone must
 * compose this into its WHERE clause, the owner-facing list included.
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
 * Drizzle predicate that excludes soft-deleted step logs.
 *
 * Step logs are soft-deleted instead of erased because they carry the per-step
 * network and gas the analytics breakdown aggregates. Compose this into the
 * WHERE of any read that shows a user their own steps. Aggregate readers
 * deliberately omit it and count every row, the same way the billing quota
 * counters already treat soft-deleted runs, and so does the executor resume
 * path, which must still read `output_raw` for a run purged mid-flight.
 */
export function executionLogNotDeleted(): SQL {
  return isNull(workflowExecutionLogs.deletedAt);
}

/**
 * The column write that retires a step log. Takes the timestamp so every row
 * in one purge shares a single instant, which is what makes a purge
 * identifiable after the fact.
 */
export function executionLogSoftDeleteValues(at: Date): { deletedAt: Date } {
  return { deletedAt: at };
}

/**
 * Filter the owner-facing workflow list down to entries that belong in the
 * sidebar picker: the internal `__current__` stub is excluded, and the
 * deletedAt check is a second line of defence behind the route's own
 * workflowNotDeleted() filter. Disabled rows are intentionally kept -- the
 * picker greys them out and tags them rather than hiding them.
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
