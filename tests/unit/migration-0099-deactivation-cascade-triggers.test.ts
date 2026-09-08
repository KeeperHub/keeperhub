import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Drift catch for the deactivation-cascade triggers. These are the
// DB-layer backstops for workflow/org deactivation: the execution block must
// reject runs for a deactivated workflow or deactivated org (on top of the
// existing soft-delete and owner-deactivation checks), and the org cascade
// must deactivate an owned org only when no active owner remains. The
// assertions are intentionally strict to catch a silent weakening.

const MIGRATION_PATH = join(
  import.meta.dirname,
  "../../drizzle/0099_keep_696_deactivation_cascade_triggers.sql"
);

const READ_SQL = (): string => readFileSync(MIGRATION_PATH, "utf8");

// Strip pg line-comments so identifier/name assertions ignore the prose.
const READ_SQL_DDL_ONLY = (): string =>
  READ_SQL()
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");

describe("migration 0099: execution block extended for deactivation", () => {
  it("replaces the existing block function by exact name (idempotent)", () => {
    expect(READ_SQL()).toMatch(
      /CREATE OR REPLACE FUNCTION public\.block_executions_for_inactive_workflows\(\)/
    );
  });

  it("joins organization on the workflow's organization_id", () => {
    const ddl = READ_SQL_DDL_ONLY();
    expect(ddl).toMatch(
      /LEFT JOIN organization o\s+ON o\.id = w\.organization_id/
    );
  });

  it("blocks executions for a deactivated workflow", () => {
    const ddl = READ_SQL_DDL_ONLY();
    expect(ddl).toMatch(/w\.deactivated_at/);
    expect(ddl).toMatch(/v_workflow_deactivated_at IS NOT NULL/);
    expect(READ_SQL()).toMatch(
      /MESSAGE = 'Workflow is deactivated; new executions are not allowed\.'/
    );
  });

  it("blocks executions for a deactivated organization", () => {
    const ddl = READ_SQL_DDL_ONLY();
    expect(ddl).toMatch(/o\.deactivated_at/);
    expect(ddl).toMatch(/v_org_deactivated_at IS NOT NULL/);
    expect(READ_SQL()).toMatch(
      /MESSAGE = 'Workflow organization is deactivated; new executions are not allowed\.'/
    );
  });

  it("retains the soft-delete check", () => {
    const ddl = READ_SQL_DDL_ONLY();
    expect(ddl).toMatch(/v_workflow_deleted_at IS NOT NULL/);
  });

  it("gates the owner on the org, not the creating user (no users join)", () => {
    const ddl = READ_SQL_DDL_ONLY();
    // Ownership is org-based: the function must not join users or check a
    // creator-user deactivation. The org's deactivated_at is the owner gate.
    expect(ddl).not.toMatch(/v_owner_deactivated_at/);
    expect(ddl).not.toMatch(/LEFT JOIN users/);
  });
});

describe("migration 0099: cascade org deactivation on owner", () => {
  it("creates the cascade function by exact name (idempotent)", () => {
    expect(READ_SQL()).toMatch(
      /CREATE OR REPLACE FUNCTION public\.cascade_org_deactivation_on_owner\(\)/
    );
  });

  it("fires only on the NULL -> non-NULL deactivated_at transition", () => {
    const ddl = READ_SQL_DDL_ONLY();
    expect(ddl).toMatch(/AFTER UPDATE OF deactivated_at ON users/);
    expect(ddl).toMatch(
      /WHEN \(NEW\.deactivated_at IS NOT NULL AND OLD\.deactivated_at IS NULL\)/
    );
  });

  it("deactivates only orgs the deactivated user owns", () => {
    const ddl = READ_SQL_DDL_ONLY();
    expect(ddl).toMatch(/m\.user_id = NEW\.id/);
    expect(ddl).toMatch(/m\.role = 'owner'/);
  });

  it("does not deactivate an org that still has an active owner", () => {
    const ddl = READ_SQL_DDL_ONLY();
    // The "no active owner remains" guard: a NOT EXISTS over owner members
    // joined to a non-deactivated user.
    expect(ddl).toMatch(/NOT EXISTS/);
    expect(ddl).toMatch(/u2\.deactivated_at IS NULL/);
    expect(ddl).toMatch(/m2\.role = 'owner'/);
  });

  it("only writes orgs that are not already deactivated", () => {
    const ddl = READ_SQL_DDL_ONLY();
    expect(ddl).toMatch(/o\.deactivated_at IS NULL/);
  });
});
