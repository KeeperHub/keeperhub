import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  KH001_MESSAGE_FRAGMENT,
  KH001_SQLSTATE,
} from "@/lib/security/session-backstop";

// Drift catch for the sessions deactivated-owner block trigger. This is a
// defense-in-depth backstop for the deactivated-user auth bypass: it rejects
// any sessions INSERT whose owning user has deactivated_at set, covering paths
// that bypass the app-layer gate in lib/auth-deactivation-guard.ts.
//
// The trigger raises a dedicated SQLSTATE 'KH001' that the detection layer
// keys off, so the error code and message are part of a contract -- the
// assertions below are deliberately strict to catch a silent weakening.

const MIGRATION_PATH = join(
  import.meta.dirname,
  "../../drizzle/0090_block_sessions_for_deactivated_users.sql"
);

const READ_SQL = (): string => readFileSync(MIGRATION_PATH, "utf8");

// Strip pg line-comments (`-- ...`) so identifier-name assertions can ignore
// the migration's prose. Sibling trigger names appear in comments intentionally
// (to document the relationship); checking the full file text would
// false-positive on those.
const READ_SQL_DDL_ONLY = (): string =>
  READ_SQL()
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");

describe("migration 0090: block sessions for deactivated owners", () => {
  it("creates the block function by exact name (idempotent)", () => {
    const sql = READ_SQL();
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION public\.block_sessions_for_deactivated_users\(\)/
    );
  });

  it("checks the owning user's deactivated_at via user_id", () => {
    const ddl = READ_SQL_DDL_ONLY();
    expect(ddl).toMatch(/FROM public\.users u/);
    expect(ddl).toMatch(/WHERE u\.id = NEW\.user_id/);
    expect(ddl).toMatch(/v_owner_deactivated_at IS NOT NULL/);
  });

  it("raises the KH001 detection signal with the exact message", () => {
    const sql = READ_SQL();
    expect(sql).toMatch(/ERRCODE = 'KH001'/);
    expect(sql).toMatch(
      /MESSAGE = 'Session owner is deactivated; new sessions are not allowed\.'/
    );
  });

  it("keeps the session-backstop runtime constants coupled to this migration", () => {
    // lib/security/session-backstop.ts walks the cause chain for
    // KH001_SQLSTATE and, as a last resort, matches KH001_MESSAGE_FRAGMENT in
    // the error text. Both constants are owned by this migration's RAISE. The
    // assertions above pin the literal SQL; this one pins the *runtime
    // constants* against it, so editing the trigger text without updating the
    // constants (or vice versa) fails here instead of silently rotting the
    // fallback path.
    const sql = READ_SQL();
    expect(sql).toContain(`ERRCODE = '${KH001_SQLSTATE}'`);
    expect(sql).toContain(KH001_MESSAGE_FRAGMENT);
  });

  it("installs a BEFORE INSERT row trigger on sessions by exact name", () => {
    const ddl = READ_SQL_DDL_ONLY();
    expect(ddl).toMatch(
      /DROP TRIGGER IF EXISTS block_sessions_for_deactivated_users ON sessions;/
    );
    expect(ddl).toMatch(
      /CREATE TRIGGER block_sessions_for_deactivated_users\s+BEFORE INSERT ON sessions\s+FOR EACH ROW\s+EXECUTE FUNCTION public\.block_sessions_for_deactivated_users\(\);/
    );
  });

  it("gates only INSERT, leaving UPDATE/DELETE of existing sessions alone", () => {
    const ddl = READ_SQL_DDL_ONLY();
    expect(ddl).not.toMatch(/BEFORE\s+(?:INSERT\s+OR\s+)?(?:UPDATE|DELETE)/);
  });

  it("does not touch sibling security triggers (0082/0084/0085)", () => {
    const ddl = READ_SQL_DDL_ONLY();
    expect(ddl).not.toMatch(/block_executions_security_2026_05_21/);
    expect(ddl).not.toMatch(/block_executions_for_inactive_workflows/);
    expect(ddl).not.toMatch(/block_database_integration/);
    expect(ddl).not.toMatch(/block_user_signup_security_2026_05_21/);
    expect(ddl).not.toMatch(/cascade_user_deactivation/);
  });

  it("does not use wildcard / LIKE matchers in any DROP statement", () => {
    const sql = READ_SQL();
    const dropStatements = sql
      .split("\n")
      .filter((line) => /^\s*DROP\s+/i.test(line));
    for (const stmt of dropStatements) {
      expect(stmt).not.toMatch(/LIKE|REGEXP|~/);
      expect(stmt).not.toMatch(/\*/);
    }
  });
});
