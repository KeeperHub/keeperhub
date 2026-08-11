#!/usr/bin/env tsx

/**
 * backfill-drizzle-migrations.ts
 *
 * Marks existing migrations as already-applied in `drizzle.__drizzle_migrations`
 * without re-running their SQL.
 *
 * Use case: a local dev DB that was bootstrapped via `pnpm db:push` (which
 * applies the schema directly without touching the migration journal table).
 * In that state, `pnpm db:migrate` tries to apply 0000-NNNN from scratch and
 * fails on `relation already exists`. Backfilling the journal table tells
 * drizzle "everything up to NNNN is already applied", so the next migrate
 * cleanly applies only the new ones.
 *
 * What it does:
 *   1. Reads `drizzle/meta/_journal.json` to enumerate migrations
 *   2. For each migration, computes sha256 of its .sql file (matches drizzle's
 *      readMigrationFiles hash format)
 *   3. Inserts into `drizzle.__drizzle_migrations` (id SERIAL, hash text,
 *      created_at bigint = journal.when), skipping any already-present hash
 *
 * Safety:
 *   - Idempotent: re-running is a no-op (skips duplicate hashes)
 *   - Non-destructive: never DROPs anything, never modifies user data
 *   - Limited to local dev: refuses to run against non-localhost DATABASE_URL
 *     unless ALLOW_REMOTE=1 is set (in which case you really know what you're
 *     doing and accept the risk)
 *
 * Usage:
 *   pnpm tsx scripts/backfill-drizzle-migrations.ts        # backfill all
 *   pnpm tsx scripts/backfill-drizzle-migrations.ts --through 0054
 *                                                          # only 0000..0054
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config as loadEnv } from "dotenv";
import postgres from "postgres";

// Override shell env so DATABASE_URL from .env wins (matches drizzle-kit
// behaviour, which loads via drizzle.config.ts -> dotenv).
loadEnv({ override: true });

type JournalEntry = {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
};

type Journal = {
  version: string;
  dialect: string;
  entries: JournalEntry[];
};

function parseThroughArg(): string | null {
  const idx = process.argv.indexOf("--through");
  if (idx === -1) {
    return null;
  }
  const value = process.argv[idx + 1];
  if (!value) {
    throw new Error("--through requires a value (e.g. --through 0054)");
  }
  return value;
}

function assertLocalOrAllowed(url: string): void {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    hostname = "";
  }
  const isLocal =
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "";
  if (!isLocal && process.env.ALLOW_REMOTE !== "1") {
    throw new Error(
      `Refusing to run against non-local host '${hostname}'. Set ALLOW_REMOTE=1 to override.`
    );
  }
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL not set");
  }
  assertLocalOrAllowed(url);

  const through = parseThroughArg();
  const repoRoot = path.resolve(__dirname, "..");
  const migrationsDir = path.join(repoRoot, "drizzle");
  const journalPath = path.join(migrationsDir, "meta", "_journal.json");

  const journal = JSON.parse(
    fs.readFileSync(journalPath, "utf8")
  ) as Journal;

  const entries = journal.entries.slice().sort((a, b) => a.idx - b.idx);
  const filtered = through
    ? entries.filter((e) => {
        const prefix = e.tag.split("_")[0];
        return prefix <= through;
      })
    : entries;

  const sql = postgres(url, { max: 1 });
  try {
    await sql`CREATE SCHEMA IF NOT EXISTS drizzle`;
    await sql`
      CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      )
    `;

    const existing = await sql<{ hash: string }[]>`
      SELECT hash FROM drizzle.__drizzle_migrations
    `;
    const existingHashes = new Set(existing.map((r) => r.hash));

    let inserted = 0;
    let skipped = 0;
    for (const entry of filtered) {
      const sqlPath = path.join(migrationsDir, `${entry.tag}.sql`);
      if (!fs.existsSync(sqlPath)) {
        console.warn(`  skip: missing ${entry.tag}.sql`);
        continue;
      }
      const content = fs.readFileSync(sqlPath, "utf8");
      const hash = crypto.createHash("sha256").update(content).digest("hex");
      if (existingHashes.has(hash)) {
        skipped++;
        continue;
      }
      await sql`
        INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
        VALUES (${hash}, ${entry.when})
      `;
      console.log(`  inserted: ${entry.tag} (when=${entry.when})`);
      inserted++;
    }

    console.log(
      `\nDone. Inserted ${inserted}, skipped ${skipped} (already present), out of ${filtered.length} candidate entries.`
    );
  } finally {
    await sql.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
