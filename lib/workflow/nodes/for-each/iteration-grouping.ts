/**
 * Pure helper functions for grouping For Each execution logs by iteration.
 *
 * Shared by:
 *   - components/workflow/workflow-runs.tsx (UI rendering)
 *   - tests/unit/iteration-grouping.test.ts
 *
 * Uses a generic constraint so callers pass their own log type (e.g., the
 * upstream ExecutionLog) without this module redefining it.
 */

/** Discriminant value for For Each group entries in grouped log output. */
export const FOR_EACH_GROUP_TYPE = "for-each-group" as const;

/** Minimal fields the grouping functions require from a log entry. */
export type IterationLogFields = {
  nodeId: string;
  nodeType: string;
  startedAt: Date;
  iterationIndex: number | null;
  forEachNodeId: string | null;
};

export type IterationGroup<T extends IterationLogFields> = {
  iterationIndex: number;
  logs: T[];
};

export type GroupedLogEntry<T extends IterationLogFields> =
  | { type: "standalone"; log: T }
  | {
      type: typeof FOR_EACH_GROUP_TYPE;
      forEachLog: T;
      iterations: IterationGroup<T>[];
      collectLog: T | null;
    };

/** Pre-built lookup maps for child and collect logs, keyed by forEachNodeId. */
export type ChildLogsLookup<T extends IterationLogFields> = {
  childLogs: Map<string, T[]>;
  collectLogs: Map<string, T[]>;
  /** For Each nodeId -> sorted invocation logs (multiple when nested). */
  invocations: Map<string, T[]>;
};

const sortByStartedAt = <T extends IterationLogFields>(a: T, b: T): number =>
  new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime();

/**
 * Build lookup maps from a flat log array. Call once on the full log set
 * and pass the result to recursive `groupLogsByIteration` calls so nested
 * For Each nodes can find their children.
 */
export function buildChildLogsLookup<T extends IterationLogFields>(
  logs: T[]
): ChildLogsLookup<T> {
  const childLogs = new Map<string, T[]>();
  const collectLogs = new Map<string, T[]>();
  const invocations = new Map<string, T[]>();

  for (const log of logs) {
    if (log.forEachNodeId !== null && log.iterationIndex !== null) {
      const existing = childLogs.get(log.forEachNodeId) ?? [];
      existing.push(log);
      childLogs.set(log.forEachNodeId, existing);
    } else if (
      log.forEachNodeId !== null &&
      log.iterationIndex === null &&
      log.nodeType === "Collect"
    ) {
      const existing = collectLogs.get(log.forEachNodeId) ?? [];
      existing.push(log);
      collectLogs.set(log.forEachNodeId, existing);
    }

    if (log.nodeType === "For Each") {
      const existing = invocations.get(log.nodeId) ?? [];
      existing.push(log);
      invocations.set(log.nodeId, existing);
    }
  }

  // Sort invocations and collects by startedAt for time-window partitioning
  for (const arr of invocations.values()) {
    arr.sort(sortByStartedAt);
  }
  for (const arr of collectLogs.values()) {
    arr.sort(sortByStartedAt);
  }

  return { childLogs, collectLogs, invocations };
}

/**
 * Group child logs by iteration index and sort them chronologically.
 */
export function buildIterationGroups<T extends IterationLogFields>(
  childLogs: T[]
): IterationGroup<T>[] {
  const iterationMap = new Map<number, T[]>();
  for (const child of childLogs) {
    const idx = child.iterationIndex ?? 0;
    const existing = iterationMap.get(idx) ?? [];
    existing.push(child);
    iterationMap.set(idx, existing);
  }

  return Array.from(iterationMap.entries())
    .sort(([a], [b]) => a - b)
    .map(([index, iterLogs]) => ({
      iterationIndex: index,
      logs: iterLogs.sort(
        (a, b) =>
          new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime()
      ),
    }));
}

/**
 * Transform a flat log array into grouped entries where For Each body
 * node logs are nested under their parent For Each node by iteration.
 *
 * Pass a pre-built `lookup` (from `buildChildLogsLookup`) when calling
 * recursively on iteration sub-arrays so nested For Each nodes can find
 * their children in the full log set.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: nested For Each + time-window partitioning requires branching
export function groupLogsByIteration<T extends IterationLogFields>(
  logs: T[],
  lookup?: ChildLogsLookup<T>
): GroupedLogEntry<T>[] {
  const {
    childLogs: forEachChildLogs,
    collectLogs: forEachCollectLogs,
    invocations: forEachInvocations,
  } = lookup ?? buildChildLogsLookup(logs);

  // Track which node IDs are present in the current logs array so we only
  // skip body logs whose parent For Each is in this array.  In recursive
  // calls (iterating over an outer iteration's sub-logs), the parent For
  // Each is NOT in the array, so nested For Each nodes won't be skipped.
  const nodeIdsInLogs = new Set<string>();
  for (const log of logs) {
    nodeIdsInLogs.add(log.nodeId);
  }

  const result: GroupedLogEntry<T>[] = [];

  for (const log of logs) {
    // Skip iteration body logs whose parent For Each is in this logs array
    if (
      log.forEachNodeId !== null &&
      log.iterationIndex !== null &&
      nodeIdsInLogs.has(log.forEachNodeId)
    ) {
      continue;
    }

    // Skip Collect logs linked to a For Each -- they'll be attached to their group
    if (
      log.nodeType === "Collect" &&
      log.forEachNodeId !== null &&
      log.iterationIndex === null &&
      forEachCollectLogs.has(log.forEachNodeId)
    ) {
      continue;
    }

    // For Each parent with child logs: build iteration groups
    if (log.nodeType === "For Each" && forEachChildLogs.has(log.nodeId)) {
      const allChildren = forEachChildLogs.get(log.nodeId) ?? [];
      const invocs = forEachInvocations.get(log.nodeId) ?? [];
      const allCollects = forEachCollectLogs.get(log.nodeId) ?? [];

      let children: T[];
      let collectLog: T | null;

      if (invocs.length > 1) {
        // Multi-invocation (nested For Each): filter by time window
        const thisStart = new Date(log.startedAt).getTime();
        const thisIdx = invocs.indexOf(log);
        const nextStart =
          thisIdx >= 0 && thisIdx < invocs.length - 1
            ? new Date(invocs[thisIdx + 1].startedAt).getTime()
            : Number.POSITIVE_INFINITY;

        children = allChildren.filter((c) => {
          const t = new Date(c.startedAt).getTime();
          return t >= thisStart && t < nextStart;
        });
        collectLog =
          allCollects.find((c) => {
            const t = new Date(c.startedAt).getTime();
            return t >= thisStart && t < nextStart;
          }) ?? null;
      } else {
        children = allChildren;
        collectLog = allCollects[0] ?? null;
      }

      const iterations = buildIterationGroups(children);
      result.push({
        type: FOR_EACH_GROUP_TYPE,
        forEachLog: log,
        iterations,
        collectLog,
      });
    } else {
      result.push({ type: "standalone", log });
    }
  }

  return result;
}
