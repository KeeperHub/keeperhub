import { spawnSync } from "node:child_process";
import fs from "node:fs";
import * as path from "node:path";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

/**
 * Recovery for the `db:push` -> `db:migrate` handoff in local development.
 *
 * Migrations run in-process here rather than through `pnpm db:migrate`.
 * drizzle-kit's `migrate` command exits non-zero with no diagnostic at all -
 * measured against 0.31.10, a failing migrate writes 0 bytes to stderr and only
 * its banner to stdout, for a schema collision and for an unreachable database
 * alike. Nothing can be classified from that, so the drift signal has to be the
 * thrown error. `drizzle-orm/postgres-js/migrator` reads the same journal, uses
 * the same sha256-of-file hash, and writes the same
 * `drizzle.__drizzle_migrations` rows, so this is the same migration semantics
 * with the error preserved.
 */

const MISSING_RELATION = /relation .* does not exist|undefined_table/i;
const ALREADY_EXISTS = /already exists/i;

/** SQLSTATEs for "this object is already there" - the shape db:push drift takes. */
const DUPLICATE_OBJECT_CODES = new Set([
  "42P07", // duplicate_table
  "42701", // duplicate_column
  "42710", // duplicate_object (constraint, type, index)
  "42P06", // duplicate_schema
]);

const BACKFILL_SCRIPT = path.join(
  __dirname,
  "..",
  "backfill-drizzle-migrations.ts"
);
const MIGRATIONS_DIR = path.join(__dirname, "..", "..", "drizzle");
const JOURNAL_PATH = path.join(MIGRATIONS_DIR, "meta", "_journal.json");

export const MIGRATE_LABEL = "database migration";
export const BACKFILL_COMMAND =
  "pnpm tsx scripts/backfill-drizzle-migrations.ts";

const SPAWN_MAX_BUFFER = 10 * 1024 * 1024;
const MAX_CAUSE_DEPTH = 16;

type JournalEntry = {
  idx: number;
  tag: string;
  when: number;
};

export type PostgresClient = ReturnType<typeof postgres>;

export type CommandResult = {
  ok: boolean;
  output: string;
  status: number | null;
};

export type MigrateRecoveryResult = {
  ok: boolean;
  /** Detail for stderr: the underlying failure, plus backfill output if run. */
  output: string;
  /** One-line reason, suitable for an Error message. */
  reason?: string;
};

export type JournalDriftState = {
  usersExists: boolean;
  journalCount: number;
  expectedCount: number;
};

type MaybePgError = {
  code?: string;
  message?: string;
  name?: string;
  cause?: unknown;
};

function readJournalEntries(): JournalEntry[] {
  const journal = JSON.parse(fs.readFileSync(JOURNAL_PATH, "utf8")) as {
    entries: JournalEntry[];
  };
  return journal.entries.slice().sort((a, b) => a.idx - b.idx);
}

export function getExpectedJournalCount(): number {
  return readJournalEntries().length;
}

function matchesCause(
  error: unknown,
  predicate: (err: MaybePgError) => boolean
): boolean {
  let current: unknown = error;
  // Bounded so a self-referential cause chain cannot spin here.
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (!current || typeof current !== "object") {
      return false;
    }
    const err = current as MaybePgError;
    if (predicate(err)) {
      return true;
    }
    if (err.cause === undefined) {
      return false;
    }
    current = err.cause;
  }
  return false;
}

/** True when Postgres reports the journal table (or its schema) is missing. */
export function isMissingRelationError(error: unknown): boolean {
  return matchesCause(
    error,
    (err) =>
      err.code === "42P01" ||
      (typeof err.message === "string" && MISSING_RELATION.test(err.message))
  );
}

/**
 * True when a migration failed because an object it creates already exists -
 * the signature of a schema applied by `db:push` ahead of the journal.
 */
export function isDuplicateObjectError(error: unknown): boolean {
  return matchesCause(error, (err) => {
    if (typeof err.code === "string") {
      return DUPLICATE_OBJECT_CODES.has(err.code);
    }
    // Codes are the reliable signal. The message check only covers a wrapper
    // that drops `code` while keeping the original text.
    return typeof err.message === "string" && ALREADY_EXISTS.test(err.message);
  });
}

/** Flattens an error and its cause chain into stderr-ready text. */
export function describeError(error: unknown): string {
  const lines: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (!current || typeof current !== "object") {
      if (current !== undefined && current !== null) {
        lines.push(String(current));
      }
      break;
    }
    const err = current as MaybePgError;
    const code = err.code ? ` [${err.code}]` : "";
    const prefix = depth === 0 ? "" : "caused by: ";
    lines.push(`${prefix}${err.name ?? "Error"}${code}: ${err.message ?? ""}`);
    if (err.cause === undefined) {
      break;
    }
    current = err.cause;
  }
  return lines.join("\n");
}

export async function queryJournalDriftState(
  client: PostgresClient
): Promise<JournalDriftState> {
  const usersExists = await client<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'users'
    ) AS exists
  `;

  const journalCount = await client<{ c: number }[]>`
    SELECT COALESCE(
      (SELECT COUNT(*)::int FROM drizzle.__drizzle_migrations),
      0
    ) AS c
  `.catch((error: unknown) => {
    if (isMissingRelationError(error)) {
      return [{ c: 0 }];
    }
    throw error;
  });

  return {
    usersExists: usersExists[0]?.exists ?? false,
    journalCount: journalCount[0]?.c ?? 0,
    expectedCount: getExpectedJournalCount(),
  };
}

/**
 * Decides whether a failed migration is `db:push` drift, from database state
 * and the thrown error.
 *
 * The backfill this gates is unbounded. A duplicate-object failure means a
 * pending migration tried to create something the database already has, and the
 * only thing that puts objects ahead of the journal in a dev database is
 * `db:push` - which applies the whole working-tree schema, i.e. the state after
 * the last journal entry. So every entry is genuinely already applied. Bounding
 * the backfill at the highest tag already recorded cannot help: those are
 * exactly the entries the backfill must skip.
 *
 * The one case this marks too much: `db:push` at some commit, then pulling
 * migrations authored after it, then bootstrapping without pushing again. Those
 * are recorded without their SQL running; `runMigrateWithRecovery` says so.
 */
export async function shouldRecoverAfterMigrateFailure(
  client: PostgresClient,
  error: unknown
): Promise<boolean> {
  const state = await queryJournalDriftState(client);

  if (!state.usersExists || state.journalCount >= state.expectedCount) {
    return false;
  }

  return isDuplicateObjectError(error);
}

export function runBackfillScript(
  env: NodeJS.ProcessEnv = process.env
): CommandResult {
  const result = spawnSync("pnpm", ["tsx", BACKFILL_SCRIPT], {
    stdio: ["ignore", "pipe", "pipe"],
    env,
    encoding: "utf8",
    maxBuffer: SPAWN_MAX_BUFFER,
  });

  if (result.error) {
    return { ok: false, output: result.error.message, status: result.status };
  }

  const output = [result.stdout, result.stderr]
    .filter((value) => value != null && value !== "")
    .map((value) => (typeof value === "string" ? value : String(value)))
    .join("\n");

  return { ok: result.status === 0, output, status: result.status };
}

/**
 * Writes failure detail to stderr and throws with the one-line reason. Used by
 * `dev-bootstrap` after `runMigrateWithRecovery`.
 */
export function assertMigrateSucceeded(result: MigrateRecoveryResult): void {
  if (result.ok) {
    return;
  }

  if (result.output) {
    process.stderr.write(result.output);
    if (!result.output.endsWith("\n")) {
      process.stderr.write("\n");
    }
  }
  throw new Error(result.reason ?? `${MIGRATE_LABEL} failed`);
}

export type MigrateAttempt = { ok: boolean; error?: unknown };

/**
 * The migrator opens with `CREATE SCHEMA IF NOT EXISTS drizzle` and
 * `CREATE TABLE IF NOT EXISTS ...__drizzle_migrations`, so Postgres raises these
 * two notices on every run after the first. postgres.js prints the whole notice
 * object by default; drop just these and let anything else through.
 */
const EXPECTED_NOTICE_CODES = new Set(["42P06", "42P07"]);

function onNotice(notice: { code?: string; message?: string }): void {
  if (notice.code && EXPECTED_NOTICE_CODES.has(notice.code)) {
    return;
  }
  console.log(`notice: ${notice.message ?? ""}`);
}

/** Applies pending migrations in-process so failures surface as real errors. */
export async function runMigrations(
  databaseUrl: string
): Promise<MigrateAttempt> {
  let client: PostgresClient | null = null;
  try {
    // Inside the try: a malformed URL makes postgres() throw synchronously,
    // and that belongs in the returned result like any other failure.
    client = postgres(databaseUrl, { max: 1, onnotice: onNotice });
    await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_DIR });
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  } finally {
    await client?.end().catch(() => undefined);
  }
}

export async function runMigrateWithRecovery(
  databaseUrl: string,
  env: NodeJS.ProcessEnv = process.env,
  log: (message: string) => void = (message) => console.log(message)
): Promise<MigrateRecoveryResult> {
  const first = await runMigrations(databaseUrl);
  if (first.ok) {
    return { ok: true, output: "" };
  }

  const firstOutput = describeError(first.error);
  const migrateFailure: MigrateRecoveryResult = {
    ok: false,
    output: firstOutput,
    reason: `${MIGRATE_LABEL} failed`,
  };

  // The probe is best-effort. If the migration failed because the database is
  // unreachable, connecting here fails too, and letting that escape would
  // replace the migration error the caller is about to print with a connection
  // stack trace. Any probe failure means "cannot classify".
  let shouldRecover: boolean;
  try {
    const client = postgres(databaseUrl, { max: 1 });
    try {
      shouldRecover = await shouldRecoverAfterMigrateFailure(
        client,
        first.error
      );
    } finally {
      await client.end();
    }
  } catch {
    return migrateFailure;
  }

  if (!shouldRecover) {
    return migrateFailure;
  }

  log("dev-bootstrap: migration drift detected (schema ahead of journal)");
  log(
    "dev-bootstrap: marking all journal entries applied - if you pulled new " +
      "migrations since your last db:push, run pnpm db:push again afterwards"
  );
  log("dev-bootstrap: running backfill-drizzle-migrations.ts...");

  const backfill = runBackfillScript(env);
  if (!backfill.ok) {
    return {
      ok: false,
      output: [firstOutput, backfill.output].filter(Boolean).join("\n"),
      reason: `${BACKFILL_COMMAND} exited with status ${backfill.status ?? "null"}`,
    };
  }

  log("dev-bootstrap: journal backfilled; retrying migration once");

  const retry = await runMigrations(databaseUrl);
  if (retry.ok) {
    return { ok: true, output: "" };
  }

  return {
    ok: false,
    output: [firstOutput, describeError(retry.error)].filter(Boolean).join("\n"),
    reason: `${MIGRATE_LABEL} failed after journal backfill`,
  };
}
