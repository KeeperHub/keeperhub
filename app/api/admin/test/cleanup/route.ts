import { like, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { authenticateAdmin } from "@/lib/admin-auth";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";

const K6_EMAIL_PATTERN = "k6-%@techops.services";
const VERIFICATION_PATTERN = "email-verification-otp-k6-%@techops.services";
const MAX_ATTEMPTS = 10;

// Allowlist for identifiers returned by information_schema.
const IDENT_RE = /^[a-z_][a-z0-9_]*$/i;

type FkRow = { table_name: string; column_name: string };

// Single cleanup pass — deletes what it can, ignores lock/FK errors.
// Returns the number of remaining test users.
async function cleanupPass(): Promise<number> {
  const userSubquery = sql`SELECT id FROM users WHERE email LIKE ${K6_EMAIL_PATTERN}`;
  const wfSubquery = sql`SELECT id FROM workflows WHERE user_id IN (${userSubquery})`;

  // Disable workflows to stop scheduler from creating new executions.
  await db.execute(sql`
    UPDATE workflows SET enabled = false
    WHERE user_id IN (${userSubquery})
  `).catch(() => {});

  // Cancel running executions so rows aren't locked.
  await db.execute(sql`
    UPDATE workflow_executions SET status = 'cancelled'
    WHERE status = 'running' AND workflow_id IN (${wfSubquery})
  `).catch(() => {});

  // Delete in FK-safe order. Each statement runs independently —
  // if one fails (lock, timeout), the next pass will retry.
  const statements = [
    sql`DELETE FROM workflow_execution_logs WHERE execution_id IN (
      SELECT id FROM workflow_executions WHERE workflow_id IN (${wfSubquery}))`,
    sql`DELETE FROM workflow_executions WHERE workflow_id IN (${wfSubquery})`,
    sql`DELETE FROM workflow_schedules WHERE workflow_id IN (${wfSubquery})`,
  ];

  for (const stmt of statements) {
    await db.execute(stmt).catch(() => {});
  }

  // Discover all tables with a direct FK to users.id and delete from each.
  const fkRows = await db.execute<FkRow>(sql`
    SELECT kcu.table_name::text AS table_name, kcu.column_name::text AS column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND ccu.table_name = 'users' AND ccu.column_name = 'id'
      AND tc.table_schema = 'public'
  `);

  const skip = new Set([
    "workflow_execution_logs",
    "workflow_executions",
    "workflow_schedules",
  ]);

  // workflows last — other tables reference it.
  const sorted = [...fkRows]
    .filter((r) => !skip.has(r.table_name))
    .sort((a, b) => {
      if (a.table_name === "workflows") return 1;
      if (b.table_name === "workflows") return -1;
      return 0;
    });

  for (const row of sorted) {
    if (!(IDENT_RE.test(row.table_name) && IDENT_RE.test(row.column_name))) {
      continue;
    }
    await db.execute(sql`
      DELETE FROM ${sql.identifier(row.table_name)}
      WHERE ${sql.identifier(row.column_name)} IN (${userSubquery})
    `).catch(() => {});
  }

  // Verifications by email pattern (no FK to users).
  await db.execute(sql`
    DELETE FROM verifications
    WHERE identifier LIKE ${VERIFICATION_PATTERN}
  `).catch(() => {});

  // Organizations — cascade handles org-scoped tables.
  await db.execute(sql`
    DELETE FROM organization WHERE id IN (
      SELECT DISTINCT m.organization_id FROM member m
      WHERE m.user_id IN (${userSubquery})
    )
  `).catch(() => {});

  // Users themselves.
  await db.execute(sql`
    DELETE FROM users WHERE email LIKE ${K6_EMAIL_PATTERN}
  `).catch(() => {});

  // Count remaining.
  const remaining = await db
    .select({ id: users.id })
    .from(users)
    .where(like(users.email, K6_EMAIL_PATTERN));

  return remaining.length;
}

export async function POST(request: Request): Promise<NextResponse> {
  const auth = authenticateAdmin(request);
  if (!auth.authenticated) {
    return NextResponse.json(
      { error: auth.error ?? "Unauthorized" },
      { status: auth.error?.includes("disabled") ? 403 : 401 }
    );
  }

  let body: { dryRun?: boolean } = {};
  try {
    body = await request.json();
  } catch {
    // default
  }

  try {
    const testUsers = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(like(users.email, K6_EMAIL_PATTERN));

    if (testUsers.length === 0) {
      return NextResponse.json({
        deleted: { users: 0, organizations: 0, workflows: 0 },
        emails: [],
        dryRun: body.dryRun === true,
      });
    }

    const userCount = testUsers.length;
    const emails = testUsers.map((u) => u.email).filter(Boolean) as string[];

    if (body.dryRun === true) {
      const wfStats = await db.execute<{
        total: string;
        enabled: string;
      }>(sql`
        SELECT
          count(*)::text as total,
          count(*) FILTER (WHERE enabled = true)::text as enabled
        FROM workflows
        WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${K6_EMAIL_PATTERN})
      `);
      const execStats = await db.execute<{
        total: string;
        success: string;
        error: string;
        running: string;
      }>(sql`
        SELECT
          count(*)::text as total,
          count(*) FILTER (WHERE status = 'success')::text as success,
          count(*) FILTER (WHERE status = 'error')::text as error,
          count(*) FILTER (WHERE status = 'running')::text as running
        FROM workflow_executions
        WHERE workflow_id IN (
          SELECT id FROM workflows
          WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${K6_EMAIL_PATTERN})
        )
      `);
      const et = Number(execStats[0]?.total ?? 0);
      const es = Number(execStats[0]?.success ?? 0);
      const ee = Number(execStats[0]?.error ?? 0);
      const er = Number(execStats[0]?.running ?? 0);

      return NextResponse.json({
        users: userCount,
        workflows: {
          total: Number(wfStats[0]?.total ?? 0),
          enabled: Number(wfStats[0]?.enabled ?? 0),
        },
        executions: {
          total: et,
          success: es,
          error: ee,
          running: er,
          successRate: et > 0 ? Math.round((10000 * es) / et) / 100 : 100,
        },
        dryRun: true,
      });
    }

    // Count workflows and executions before deleting.
    const wfCount = await db.execute<{ count: string }>(sql`
      SELECT count(*)::text as count FROM workflows
      WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${K6_EMAIL_PATTERN})
    `);
    const deletedWorkflows = Number(wfCount[0]?.count ?? 0);

    const execCount = await db.execute<{
      total: string;
      success: string;
      error: string;
    }>(sql`
      SELECT
        count(*)::text as total,
        count(*) FILTER (WHERE status = 'success')::text as success,
        count(*) FILTER (WHERE status = 'error')::text as error
      FROM workflow_executions
      WHERE workflow_id IN (
        SELECT id FROM workflows
        WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${K6_EMAIL_PATTERN})
      )
    `);
    const execTotal = Number(execCount[0]?.total ?? 0);
    const execSuccess = Number(execCount[0]?.success ?? 0);
    const execError = Number(execCount[0]?.error ?? 0);

    // Run cleanup in a loop — each pass deletes what it can.
    // Locked rows (from in-flight executions) are skipped and caught next pass.
    let remaining = userCount;
    let attempts = 0;

    while (remaining > 0 && attempts < MAX_ATTEMPTS) {
      attempts++;
      remaining = await cleanupPass();

      if (remaining > 0 && attempts < MAX_ATTEMPTS) {
        // Brief pause to let in-flight executions finish.
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }

    const deletedUsers = userCount - remaining;

    return NextResponse.json({
      deleted: {
        users: deletedUsers,
        organizations: deletedUsers,
        workflows: deletedWorkflows,
      },
      executions: {
        total: execTotal,
        success: execSuccess,
        error: execError,
        successRate:
          execTotal > 0
            ? Math.round((10000 * execSuccess) / execTotal) / 100
            : 100,
      },
      emails,
      dryRun: false,
      attempts,
      remaining,
    });
  } catch (error) {
    console.error("Admin cleanup failed:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
