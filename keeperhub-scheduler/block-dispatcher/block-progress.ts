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

/**
 * Lease annotation holding a JSON object of organization route key to last
 * processed block. Route keys are fingerprints and carry no URL.
 */
export const ROUTE_BLOCK_PROGRESS_ANNOTATION =
  "keeperhub.io/route-block-progress";

function parseProgressObject<K>(
  raw: string | undefined,
  parseKey: (key: string) => K | null,
): Map<K, number> {
  const progress = new Map<K, number>();
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

  for (const [rawKey, value] of Object.entries(parsed)) {
    const key = parseKey(rawKey);
    if (
      key !== null &&
      typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 0
    ) {
      progress.set(key, value);
    }
  }
  return progress;
}

/** Parse the annotation value. Anything malformed is skipped, never thrown. */
export function parseBlockProgress(
  raw: string | undefined,
): Map<number, number> {
  return parseProgressObject(raw, (key) => {
    const chainId = Number(key);
    return Number.isSafeInteger(chainId) && chainId > 0 ? chainId : null;
  });
}

/** Parse the route annotation value, skipping anything malformed. */
export function parseRouteBlockProgress(
  raw: string | undefined,
): Map<string, number> {
  return parseProgressObject(raw, (key) => (key.length > 0 ? key : null));
}

export function serializeBlockProgress(
  progress: ReadonlyMap<number | string, number>,
): string {
  return JSON.stringify(Object.fromEntries(progress));
}
