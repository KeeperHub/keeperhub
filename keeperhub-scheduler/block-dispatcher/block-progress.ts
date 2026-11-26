/**
 * Block progress handoff
 *
 * The last fully processed block per chain, stored as one JSON annotation on
 * the leader-election Lease. The leader writes it with every renew and the
 * next leader reads it on acquire, so its monitors backfill the blocks mined
 * during the handoff instead of starting at the chain head.
 */

/** Lease annotation holding a JSON object of chainId to last processed block. */
export const BLOCK_PROGRESS_ANNOTATION = "keeperhub.io/block-progress";

/** Parse the annotation value. Anything malformed is skipped, never thrown. */
export function parseBlockProgress(
  raw: string | undefined,
): Map<number, number> {
  const progress = new Map<number, number>();
  if (!raw) {
    return progress;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.warn(
      "[BlockProgress] Ignoring unparseable block progress annotation:",
      error instanceof Error ? error.message : error,
    );
    return progress;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    console.warn(
      "[BlockProgress] Ignoring non-object block progress annotation",
    );
    return progress;
  }

  for (const [key, value] of Object.entries(parsed)) {
    const chainId = Number(key);
    if (
      Number.isSafeInteger(chainId) &&
      chainId > 0 &&
      typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 0
    ) {
      progress.set(chainId, value);
    }
  }
  return progress;
}

export function serializeBlockProgress(
  progress: ReadonlyMap<number, number>,
): string {
  return JSON.stringify(Object.fromEntries(progress));
}
