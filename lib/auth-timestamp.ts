const CANONICAL_UNIX_SECONDS = /^(0|[1-9]\d*)$/;

export function parseAuthTimestamp(value: string): number | null {
  if (!CANONICAL_UNIX_SECONDS.test(value)) {
    return null;
  }

  const timestamp = Number(value);

  return Number.isSafeInteger(timestamp) ? timestamp : null;
}
