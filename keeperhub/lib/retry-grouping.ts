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

function collapseGroup<T extends RetryLogFields>(
  group: T[]
): RetryCollapsedLog<T>[] {
  if (group.length === 1) {
    return [{ ...group[0], retryCount: 0 }];
  }

  const sorted = group.toSorted(
    (a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime()
  );

  const hasFailedPrecursors = sorted
    .slice(0, -1)
    .some((log) => log.status === "error");

  if (!hasFailedPrecursors) {
    return sorted.map((log) => ({ ...log, retryCount: 0 }));
  }

  const finalAttempt = sorted.at(-1);
  if (!finalAttempt) {
    return [];
  }
  const failedAttempts = sorted.slice(0, -1);
  return [
    {
      ...finalAttempt,
      retryCount: failedAttempts.length,
      retryLogs: failedAttempts,
    },
  ];
}

/**
 * Collapse retry entries in a flat log array.
 *
 * Groups logs by (nodeId, forEachNodeId, iterationIndex). When multiple
 * logs share the same key and earlier attempts have error status, they
 * are collapsed into a single entry showing the final result.
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
    result.push(...collapseGroup(group));
  }

  return result;
}
