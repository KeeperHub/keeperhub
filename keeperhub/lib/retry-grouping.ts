/**
 * Pure helper functions for collapsing retry logs in execution history.
 *
 * When the Workflow DevKit retries a failed step, each attempt creates a
 * separate workflowExecutionLogs row with the same nodeId. This module
 * collapses those duplicate entries into a single log showing the final
 * result with a retry count badge.
 *
 * Shared by:
 *   - components/workflow/workflow-runs.tsx (UI rendering)
 *   - keeperhub/lib/__tests__/retry-grouping.test.ts
 */

/** Minimal fields required from a log entry for retry detection. */
export type RetryLogFields = {
  nodeId: string;
  status: string;
  iterationIndex: number | null;
  forEachNodeId: string | null;
};

/** A log entry augmented with retry metadata after collapsing. */
export type RetryCollapsedLog<T extends RetryLogFields> = T & {
  retryCount: number;
  retryLogs?: T[];
};

/**
 * Build a grouping key that distinguishes retries from loop iterations.
 *
 * Two logs are retries of the same step when they share the same nodeId,
 * forEachNodeId, and iterationIndex. Different iterationIndex values
 * indicate loop iterations, not retries.
 */
function retryKey(log: RetryLogFields): string {
  const forEach = log.forEachNodeId ?? "__none__";
  const iteration = log.iterationIndex ?? "__none__";
  return `${log.nodeId}::${forEach}::${iteration}`;
}

/**
 * Collapse retry entries in a flat log array.
 *
 * Groups logs by (nodeId, forEachNodeId, iterationIndex). When multiple
 * logs share the same key, they represent retry attempts of the same step.
 * The **last** entry (final attempt) becomes the display entry. Earlier
 * entries are stored in `retryLogs` for optional expansion.
 *
 * Preserves original ordering based on the first occurrence of each group.
 */
export function collapseRetries<T extends RetryLogFields>(
  logs: T[]
): RetryCollapsedLog<T>[] {
  const groups = new Map<string, T[]>();
  const insertionOrder: string[] = [];

  for (const log of logs) {
    const key = retryKey(log);
    const existing = groups.get(key);
    if (existing) {
      existing.push(log);
    } else {
      groups.set(key, [log]);
      insertionOrder.push(key);
    }
  }

  const result: RetryCollapsedLog<T>[] = [];

  for (const key of insertionOrder) {
    const group = groups.get(key);
    if (!group) {
      continue;
    }

    if (group.length === 1) {
      result.push({ ...group[0], retryCount: 0 });
    } else {
      // group.length >= 2 guaranteed by the if/else above
      const finalAttempt = group.at(-1) as T;
      const failedAttempts = group.slice(0, -1);
      result.push({
        ...finalAttempt,
        retryCount: failedAttempts.length,
        retryLogs: failedAttempts,
      });
    }
  }

  return result;
}
