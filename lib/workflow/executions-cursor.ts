/**
 * Keyset cursor for the paginated executions list.
 *
 * The list is ordered by (started_at DESC, id DESC) and a page resumes with the
 * row-value comparison `(started_at, id) < (cursor.startedAt, cursor.id)`. The
 * id breaks ties between runs that share a start timestamp, which a cursor on
 * started_at alone would skip or repeat at a page boundary.
 *
 * `startedAt` carries the column rendered as `YYYY-MM-DD HH24:MI:SS.US`
 * (`2026-09-23 00:03:07.272123`), not a JS Date: the column holds microseconds
 * and a millisecond Date would round it, so rows inside the rounded gap could
 * vanish from or repeat on the next page.
 */
export type ExecutionsCursor = {
  startedAt: string;
  id: string;
};

const PG_TIMESTAMP_TEXT_RE =
  /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?$/;

/**
 * True when the fields name a real instant. The regex only checks the shape,
 * and Postgres rejects `2026-13-45 99:99:99` at query time, which would turn
 * a forged cursor into a 500. Date.UTC rolls impossible fields over (Feb 30
 * becomes Mar 2), so the check is that nothing rolled.
 */
function isRealTimestamp(match: RegExpMatchArray): boolean {
  const [year, month, day, hour, minute, second] = match
    .slice(1, 7)
    .map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second
  );
}

export function encodeExecutionsCursor(cursor: ExecutionsCursor): string {
  return Buffer.from(
    JSON.stringify([cursor.startedAt, cursor.id]),
    "utf8"
  ).toString("base64url");
}

/** Returns null for anything that did not come out of encodeExecutionsCursor. */
export function decodeExecutionsCursor(raw: string): ExecutionsCursor | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) {
    return null;
  }
  const [startedAt, id] = parsed as unknown[];
  if (typeof startedAt !== "string" || typeof id !== "string" || id === "") {
    return null;
  }
  const match = startedAt.match(PG_TIMESTAMP_TEXT_RE);
  if (match === null || !isRealTimestamp(match)) {
    return null;
  }
  return { startedAt, id };
}
