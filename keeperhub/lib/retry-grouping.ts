/** Minimal fields required from a log entry for retry detection. */
export type RetryLogFields = {
  nodeId: string;
  status: string;
  startedAt: Date;
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
 * Each group is sorted by `startedAt` ascending so the latest attempt
 * becomes the display entry regardless of the input order (the API may
 * return logs newest-first). Earlier attempts are stored in `retryLogs`.
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
      continue;
    }

    const sorted = [...group].sort(
      (a, b) =>
        new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime()
    );

    const hasFailedPrecursors = sorted
      .slice(0, -1)
      .some((log) => log.status === "error");

    if (!hasFailedPrecursors) {
      for (const log of sorted) {
        result.push({ ...log, retryCount: 0 });
      }
      continue;
    }

    const finalAttempt = sorted[sorted.length - 1];
    const failedAttempts = sorted.slice(0, -1);
    result.push({
      ...finalAttempt,
      retryCount: failedAttempts.length,
      retryLogs: failedAttempts,
    });
  }

  return result;
}
