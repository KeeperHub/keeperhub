import { type AnyColumn, type SQL, sql } from "drizzle-orm";
import type { RunSource, UnifiedRun } from "./types";

/**
 * Where the runs listing left off: the last row's time, source and id.
 *
 * The listing merges three tables ordered by (time desc, source, id desc), so a
 * time alone cannot say where a page ended. Rows can share a time to the
 * microsecond (every delivery of one notification is written in one
 * transaction), and a page boundary inside such a group skipped the rest of
 * it. The time is kept to the microsecond the columns hold, not the
 * millisecond a JavaScript Date carries.
 *
 * Opaque on the wire (base64url). A plain ISO time, the cursor this listing
 * minted before, is still read: it carries no source or id, so it pages the
 * way it always did.
 */
export type RunCursor = {
  /** "YYYY-MM-DDTHH:MM:SS.ffffff" (or .fff from a legacy cursor), UTC. */
  at: string;
  source: RunSource | null;
  id: string | null;
};

/**
 * Order of the sources among rows of one time, newest-first listing. Any fixed
 * order works; this one has to be the same on both sides of the keyset.
 */
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

/**
 * The rows of `source` that come after the cursor in the listing's order:
 * time descending, then source by SOURCE_RANK descending, then id descending.
 * Each source orders its own query by (time desc, id desc), so only the source
 * that owns the cursor row compares ids; at the cursor's time the sources
 * ranked above it were already listed, and the ones below were not.
 */
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

/**
 * Merge the sources into the listing's order. Stable, so rows of one source
 * and one time keep the id order their own query returned: the comparison has
 * to match Postgres's collation, which only Postgres knows.
 */
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
