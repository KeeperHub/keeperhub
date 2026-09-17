export function parseAuthTimestamp(value: string): number | null {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    return null;
  }

  const timestamp = Number(value);

  return Number.isSafeInteger(timestamp) ? timestamp : null;
}
