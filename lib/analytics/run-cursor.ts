import { type AnyColumn, type SQL, sql } from "drizzle-orm";
import type { RunSource, UnifiedRun } from "./types";

/**
 * Keyset cursor (time, source, id): rows share a microsecond time, so time alone
 * skips rows. Base64url on the wire; legacy plain-ISO cursors still parse.
 */
export type RunCursor = {
  /** "YYYY-MM-DDTHH:MM:SS.ffffff" (or .fff from a legacy cursor), UTC. */
  at: string;
  source: RunSource | null;
  id: string | null;
};

/** Any fixed order works, as long as SQL and the merge agree. */
const SOURCE_RANK: Record<RunSource, number> = {
  workflow: 2,
  direct: 1,
  notification: 0,
};

const SOURCES = new Set<string>(Object.keys(SOURCE_RANK));
const MICRO_TIME = /^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/;
const LEGACY_ISO = /^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const ROW_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SEPARATOR = "~";

/** A time a Postgres timestamp can hold and that names a real instant. */
function realInstant(at: string): boolean {
  const ms = `${at.slice(0, 23)}Z`;
  const parsed = new Date(ms);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === ms;
}

export function encodeRunCursor(cursor: {
  at: string;
  source: RunSource;
  id: string;
}): string {
  return Buffer.from(
    [cursor.at, cursor.source, cursor.id].join(SEPARATOR),
    "utf8"
  ).toString("base64url");
}

/** The cursor a caller sent, or undefined for anything this listing never minted. */
export function parseRunCursor(
  raw: string | null | undefined
): RunCursor | undefined {
  if (!raw) {
    return undefined;
  }
  if (LEGACY_ISO.test(raw)) {
    const at = raw.slice(0, -1);
    return realInstant(at) ? { at, source: null, id: null } : undefined;
  }
  if (!BASE64URL.test(raw)) {
    return undefined;
  }
  const parts = Buffer.from(raw, "base64url").toString("utf8").split(SEPARATOR);
  if (parts.length !== 3) {
    return undefined;
  }
  const [at, source, id] = parts;
  if (
    !(
      MICRO_TIME.test(at) &&
      SOURCES.has(source) &&
      ROW_ID.test(id) &&
      realInstant(at)
    )
  ) {
    return undefined;
  }
  return { at, source: source as RunSource, id };
}

/** A listed row with its exact time, the part of the keyset a Date loses. */
export type KeyedRun = { run: UnifiedRun; at: string };

/** A timestamp column as the microsecond text the keyset compares. */
export function keysetTime(column: AnyColumn): SQL<string> {
  return sql<string>`to_char(${column}, 'YYYY-MM-DD"T"HH24:MI:SS.US')`;
}

/** Rows of `source` after the cursor; only the cursor's own source compares ids. */
export function runCursorCondition(
  cursor: RunCursor,
  source: RunSource,
  time: AnyColumn,
  id: AnyColumn
): SQL {
  const at = sql`${cursor.at}::timestamp`;
  if (cursor.source === null || cursor.id === null) {
    return sql`${time} < ${at}`;
  }
  const mine = SOURCE_RANK[source];
  const theirs = SOURCE_RANK[cursor.source];
  if (mine > theirs) {
    return sql`${time} < ${at}`;
  }
  if (mine < theirs) {
    return sql`${time} <= ${at}`;
  }
  return sql`(${time}, ${id}) < (${at}, ${cursor.id}::text)`;
}

/** Stable sort, so same-time rows keep Postgres's id (collation) order. */
export function mergeKeyedRuns(lists: KeyedRun[][]): KeyedRun[] {
  return lists.flat().sort((a, b) => {
    if (a.at !== b.at) {
      return a.at < b.at ? 1 : -1;
    }
    return SOURCE_RANK[b.run.source] - SOURCE_RANK[a.run.source];
  });
}

/** The cursor that resumes the listing after this row. */
export function cursorAfter(row: KeyedRun): string {
  return encodeRunCursor({
    at: row.at,
    source: row.run.source,
    id: row.run.id,
  });
}
