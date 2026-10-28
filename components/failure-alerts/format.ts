/** "1 failed run" / "5 failed runs", worded the same everywhere in the feature. */
export function failedRuns(count: number): string {
  return `${count} failed run${count === 1 ? "" : "s"}`;
}

/**
 * One absolute date for the history and the mute line: with the viewer's time
 * zone, and the year only when it is not this year.
 */
export function formatWhen(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleString(undefined, {
    year:
      date.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}
