type LatestResult<T> =
  | { latest: false }
  | { latest: true; ok: true; value: T }
  | { latest: true; ok: false };

/**
 * Runs requests where only the most recent one counts: a reply that lands
 * after a newer request was sent comes back as `latest: false`, so it can be
 * dropped instead of being put over the newer one. A failure is reported
 * rather than thrown.
 */
export function createLatestRequest(): <T>(
  load: () => Promise<T>
) => Promise<LatestResult<T>> {
  let latest = 0;
  return async <T>(load: () => Promise<T>): Promise<LatestResult<T>> => {
    latest += 1;
    const request = latest;
    let result: { ok: true; value: T } | { ok: false };
    try {
      result = { ok: true, value: await load() };
    } catch {
      result = { ok: false };
    }
    return request === latest ? { latest: true, ...result } : { latest: false };
  };
}
