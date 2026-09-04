/**
 * Named source handles, listed in the order they render down the right edge of
 * a node. Auto-layout reads the same order, so a branch always lays out on the
 * side its handle sits on.
 */
export type SourceHandle = {
  id: string;
  label: string;
  topPercent: number;
};

export const FOR_EACH_SOURCE_HANDLES: SourceHandle[] = [
  { id: "done", label: "done", topPercent: 30 },
  { id: "loop", label: "loop", topPercent: 70 },
];

export const CONDITION_SOURCE_HANDLES: SourceHandle[] = [
  { id: "true", label: "true", topPercent: 30 },
  { id: "false", label: "false", topPercent: 70 },
];

const rank = new Map<string, number>();
for (const handles of [FOR_EACH_SOURCE_HANDLES, CONDITION_SOURCE_HANDLES]) {
  for (const [index, handle] of handles.entries()) {
    rank.set(handle.id, index);
  }
}

/** How far down a node its handle sits, 0 for the upper one, 1 for the lower. */
export function sourceHandleRank(
  handle: string | null | undefined
): number | undefined {
  return handle === null || handle === undefined ? undefined : rank.get(handle);
}
