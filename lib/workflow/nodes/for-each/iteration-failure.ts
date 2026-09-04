/**
 * Tagged For Each iteration-body failure.
 *
 * Concurrency catch sites and the executor body-failure path must stamp the
 * same marker so findFirstIterationFailure cannot miss a thrown iteration
 * (and so a successful step whose data is shaped `{ success: false }` cannot
 * false-positive the post-loop gate).
 */

export const FOR_EACH_BODY_FAILURE_MARKER = "__forEachBodyFailure" as const;

export type ForEachIterationFailure = {
  [FOR_EACH_BODY_FAILURE_MARKER]: true;
  success: false;
  error: string;
  nodeId?: string;
};

export function isForEachBodyFailureResult(
  result: unknown
): result is ForEachIterationFailure {
  if (result === null || typeof result !== "object") {
    return false;
  }
  return (
    (result as Record<string, unknown>)[FOR_EACH_BODY_FAILURE_MARKER] === true
  );
}
