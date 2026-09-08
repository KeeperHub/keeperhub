import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Drift catch for the signup-block drop migration. The migration is
// load-bearing for security (it's what re-opens real customer signup
// after the 2026-05-21 incident) and it sits next to sibling triggers
// that MUST be left alone. A future edit that widens the DROP target
// or accidentally removes the drift NOTICE would weaken the signal we
// rely on. These assertions are deliberately strict.

const MIGRATION_PATH = join(
  import.meta.dirname,
  "../../drizzle/0086_drop_employee_only_signup_block.sql"
);

const READ_SQL = (): string => readFileSync(MIGRATION_PATH, "utf8");

// Strip pg line-comments (`-- ...`) so identifier-name assertions can
// ignore the migration's prose. Sibling trigger names appear in comments
// intentionally (to document why they're left alone); checking the full
// file text would false-positive on those.
const READ_SQL_DDL_ONLY = (): string =>
  READ_SQL()
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");

describe("migration 0086: drop emergency signup whitelist trigger", () => {
  it("drops the signup-block trigger by exact name", () => {
    const sql = READ_SQL();
    expect(sql).toMatch(
      /DROP TRIGGER IF EXISTS block_user_signup_security_2026_05_21 ON users;/
    );
  });

  it("drops the signup-block function by exact name", () => {
    const sql = READ_SQL();
    expect(sql).toMatch(
      /DROP FUNCTION IF EXISTS public\.block_user_signup_security_2026_05_21\(\);/
    );
  });

  it("does not touch the executions kill-switch (migration 0082)", () => {
    const ddl = READ_SQL_DDL_ONLY();
    expect(ddl).not.toMatch(/block_executions_security_2026_05_21/);
    expect(ddl).not.toMatch(/block_executions_for_inactive_workflows/);
  });

  it("does not touch the database-integration block (migration 0082)", () => {
    const ddl = READ_SQL_DDL_ONLY();
    expect(ddl).not.toMatch(/block_database_integrations_security_2026_05_21/);
    expect(ddl).not.toMatch(/block_database_integration_type/);
  });

  it("does not touch the cascade-deactivation trigger (migration 0085)", () => {
    const ddl = READ_SQL_DDL_ONLY();
    expect(ddl).not.toMatch(/cascade_user_deactivation/);
  });

  it("does not use wildcard / LIKE matchers in any DROP statement", () => {
    const sql = READ_SQL();
    // Look for the dangerous patterns explicitly. Comment text is fine.
    const dropStatements = sql
      .split("\n")
      .filter((line) => /^\s*DROP\s+/i.test(line));
    for (const stmt of dropStatements) {
      expect(stmt).not.toMatch(/LIKE|REGEXP|~/);
      expect(stmt).not.toMatch(/\*/);
    }
  });

  it("raises a NOTICE when the target trigger is absent at drop time", () => {
    const sql = READ_SQL();
    // Surface drift loudly when ad-hoc rename / earlier drop already
    // removed the trigger - otherwise DROP IF EXISTS silently no-ops.
    expect(sql).toMatch(/RAISE NOTICE/);
    expect(sql).toMatch(
      /block_user_signup_security_2026_05_21 not present at drop time/
    );
  });

  it("references TECH-11 in the drift NOTICE so on-call has a pointer", () => {
    const sql = READ_SQL();
    expect(sql).toMatch(/TECH-11/);
  });
});
