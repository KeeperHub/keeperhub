import { randomBytes } from "node:crypto";
import { CREDENTIAL_ACCOUNT_ISSUER } from "../../../../lib/auth/account-issuer";
import { createScheduleTriggerNode } from "../../../fixtures/workflows";
import { getDbConnection } from "./connection";
import { hashPassword } from "./seed";

const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const PASSWORD = "TestPassword123!";
const MINUTE = 60_000;
const FAILED_RUNS = 5;
// CI turns alerts on for this org only (start-app's failure_alerts_rollout default).
export const ALERTS_E2E_ORG_ID = "e2e-failure-alerts-org";

function generateId(): string {
  return Array.from(
    randomBytes(21),
    (byte) => ID_ALPHABET[byte % ID_ALPHABET.length]
  ).join("");
}

export type AlertsFixture = {
  email: string;
  password: string;
  userId: string;
  orgId: string;
  /** Five failed runs and an open alert. */
  failingId: string;
  failingName: string;
  /** No runs of its own: it shows in analytics only through its alert. */
  alertedId: string;
  alertedName: string;
  /** A Discord connection the server cannot use, for the refused method. */
  discordName: string;
};

// Own user, org and alert rows; the email pattern lets the global cleanup sweep leftovers.
export async function seedFailureAlerts(): Promise<AlertsFixture> {
  await cleanupLeftoverOrg();
  const suffix = generateId().slice(0, 10);
  const email = `test+failure-alerts-${suffix}@techops.services`;
  const userId = generateId();
  const orgId = ALERTS_E2E_ORG_ID;
  const failingId = generateId();
  const alertedId = generateId();
  const failingName = `Failing Keeper ${suffix}`;
  const alertedName = `Alerted Keeper ${suffix}`;
  const discordName = `E2E Discord ${suffix}`;
  const now = new Date();
  const ago = (minutes: number): Date =>
    new Date(now.getTime() - minutes * MINUTE);
  const nodes = JSON.stringify([createScheduleTriggerNode("0 */4 * * *")]);

  const sql = getDbConnection();
  try {
    const hashed = await hashPassword(PASSWORD);
    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO users (id, name, email, email_verified, onboarding_completed, created_at, updated_at)
        VALUES (${userId}, 'Alerts Owner', ${email}, true, true, ${now}, ${now})
      `;
      await tx`
        INSERT INTO accounts (id, account_id, provider_id, issuer, user_id, password, created_at, updated_at)
        VALUES (${generateId()}, ${userId}, 'credential', ${CREDENTIAL_ACCOUNT_ISSUER}, ${userId}, ${hashed}, ${now}, ${now})
      `;
      await tx`
        INSERT INTO organization (id, name, slug, created_at)
        VALUES (${orgId}, ${`Failure Alerts E2E ${suffix}`}, ${`e2e-failure-alerts-${suffix}`}, ${now})
      `;
      await tx`
        INSERT INTO member (id, organization_id, user_id, role, created_at)
        VALUES (${generateId()}, ${orgId}, ${userId}, 'owner', ${now})
      `;
      // Launch notice marked sent, so a running cron has nothing to email.
      await tx`
        INSERT INTO alert_settings (organization_id, threshold, time_limit_minutes, counting_since, launch_notice_sent_at)
        VALUES (${orgId}, 5, NULL, ${ago(24 * 60)}, ${now})
      `;

      // Connections with no usable credentials: the server refuses them without any network call.
      const telegramId = generateId();
      for (const [id, name, type] of [
        [telegramId, `E2E Telegram ${suffix}`, "telegram"],
        [generateId(), discordName, "discord"],
      ] as const) {
        await tx`
          INSERT INTO integrations (id, created_by, organization_id, name, type, config, visibility, created_at, updated_at)
          VALUES (${id}, ${userId}, ${orgId}, ${name}, ${type}, ${sql.json({})}, 'organization', ${now}, ${now})
        `;
      }
      await tx`
        INSERT INTO alert_methods (id, organization_id, kind, integration_id, destination, role, paused_at, paused_reason, last_health_check_at, created_by)
        VALUES (${generateId()}, ${orgId}, 'telegram', ${telegramId}, '-1002233445566', 'always',
          ${ago(60)}, 'Telegram rejected the bot token', ${now}, ${userId})
      `;

      for (const [id, name] of [
        [failingId, failingName],
        [alertedId, alertedName],
      ]) {
        await tx`
          INSERT INTO workflows (id, name, user_id, organization_id, is_anonymous, nodes, edges, visibility, enabled, created_at, updated_at)
          VALUES (${id}, ${name}, ${userId}, ${orgId}, false, ${nodes}::jsonb, '[]'::jsonb, 'private', true, ${ago(120)}, ${now})
        `;
      }
      for (let i = 0; i < FAILED_RUNS; i++) {
        const at = ago(FAILED_RUNS + 1 - i);
        await tx`
          INSERT INTO workflow_executions (id, workflow_id, user_id, organization_id, status, trigger_source, started_at, completed_at, error)
          VALUES (${generateId()}, ${failingId}, ${userId}, ${orgId}, 'error', 'schedule', ${at},
            ${new Date(at.getTime() + 1000)}, 'execution reverted (RPC 429)')
        `;
      }

      // An open alert for the failing workflow and a closed one for the alerted one, each delivered by email.
      for (const [workflowId, open] of [
        [failingId, true],
        [alertedId, false],
      ] as const) {
        const incidentId = generateId();
        await tx`
          INSERT INTO alert_incidents (id, organization_id, workflow_id, opened_at, opened_by, threshold, failure_count,
            first_failed_at, last_failed_at, last_notified_at, alert_queued_at, resolved_at, resolved_reason)
          VALUES (${incidentId}, ${orgId}, ${workflowId}, ${ago(1)}, 'count', 5, 5, ${ago(6)}, ${ago(1)}, ${ago(1)}, ${ago(1)},
            ${open ? null : now}, ${open ? null : "success"})
        `;
        await tx`
          INSERT INTO alert_deliveries (id, dedup_key, organization_id, incident_id, kind, channel, recipient, state,
            attempts, next_attempt_at, created_at, updated_at, delivered_at)
          VALUES (${generateId()}, ${`e2e-failure-alerts-${suffix}-${workflowId}`}, ${orgId}, ${incidentId}, 'alert',
            'email', ${email}, 'delivered', 1, ${ago(1)}, ${ago(1)}, ${ago(1)}, ${ago(1)})
        `;
      }
    });
  } finally {
    await sql.end();
  }

  return {
    email,
    password: PASSWORD,
    userId,
    orgId,
    failingId,
    failingName,
    alertedId,
    alertedName,
    discordName,
  };
}

// Removes only this fixture's rows; replica mode skips the audit log's append-only trigger, as cleanupTestUsers does.
export async function cleanupFailureAlerts(
  fixture: Pick<AlertsFixture, "orgId" | "userId" | "email">
): Promise<void> {
  const { orgId, userId, email } = fixture;
  const sql = getDbConnection();
  try {
    await sql.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = 'replica'`;
      const workflowIds = (
        await tx`SELECT id FROM workflows WHERE organization_id = ${orgId}`
      ).map((row) => row.id as string);
      for (const table of [
        "alert_deliveries",
        "alert_incidents",
        "alert_methods",
        "alert_overrides",
        "alert_settings",
        "alert_email_usage",
        "integrations",
      ]) {
        await tx`DELETE FROM ${tx(table)} WHERE organization_id = ${orgId}`;
      }
      if (workflowIds.length > 0) {
        await tx`DELETE FROM alert_queue WHERE workflow_id IN ${tx(workflowIds)}`;
        await tx`
          DELETE FROM workflow_execution_logs WHERE execution_id IN (
            SELECT id FROM workflow_executions WHERE workflow_id IN ${tx(workflowIds)}
          )
        `;
        await tx`DELETE FROM workflow_executions WHERE workflow_id IN ${tx(workflowIds)}`;
        await tx`DELETE FROM workflow_schedules WHERE workflow_id IN ${tx(workflowIds)}`;
        await tx`DELETE FROM workflows WHERE id IN ${tx(workflowIds)}`;
      }
      await tx`DELETE FROM member WHERE organization_id = ${orgId}`;
      await tx`DELETE FROM sessions WHERE user_id = ${userId}`;
      await tx`DELETE FROM accounts WHERE user_id = ${userId}`;
      await tx`DELETE FROM organization WHERE id = ${orgId}`;
      await tx`DELETE FROM users WHERE id = ${userId}`;
      await tx`DELETE FROM verifications WHERE identifier LIKE ${`%${email}%`}`;
    });
  } finally {
    await sql.end();
  }
}

// The org id is fixed, so a run that crashed before cleanup would block the next seed.
async function cleanupLeftoverOrg(): Promise<void> {
  const sql = getDbConnection();
  let owners: { userId: string; email: string }[];
  try {
    owners = (
      await sql`
        SELECT u.id, u.email FROM member m JOIN users u ON u.id = m.user_id
        WHERE m.organization_id = ${ALERTS_E2E_ORG_ID}
      `
    ).map((row) => ({ userId: row.id as string, email: row.email as string }));
  } finally {
    await sql.end();
  }
  const [first, ...rest] = owners;
  await cleanupFailureAlerts({
    orgId: ALERTS_E2E_ORG_ID,
    userId: first?.userId ?? "",
    email: first?.email ?? ALERTS_E2E_ORG_ID,
  });
  for (const owner of rest) {
    await cleanupFailureAlerts({ orgId: ALERTS_E2E_ORG_ID, ...owner });
  }
}

export type OverrideRow = {
  threshold: number | null;
  pauseWorkflow: boolean;
  mutedUntil: Date | null;
};

// The workflow's saved override, or null when it follows the org (a reset keeps an empty row).
export async function readOverride(
  workflowId: string
): Promise<OverrideRow | null> {
  const sql = getDbConnection();
  try {
    const [row] = await sql`
      SELECT threshold, pause_workflow, muted_until FROM alert_overrides
      WHERE workflow_id = ${workflowId}
        AND (threshold IS NOT NULL OR time_limit_minutes IS NOT NULL
          OR recipient_user_ids IS NOT NULL OR custom_channels
          OR muted_until IS NOT NULL OR mute_until_success OR pause_workflow)
    `;
    return row
      ? {
          threshold: row.threshold as number | null,
          pauseWorkflow: row.pause_workflow as boolean,
          mutedUntil: row.muted_until as Date | null,
        }
      : null;
  } finally {
    await sql.end();
  }
}

// When the org's alerts are paused until, or null.
export async function readOrgPause(orgId: string): Promise<Date | null> {
  const sql = getDbConnection();
  try {
    const [row] = await sql`
      SELECT paused_until FROM alert_settings WHERE organization_id = ${orgId}
    `;
    return (row?.paused_until as Date | null) ?? null;
  } finally {
    await sql.end();
  }
}

// How many org-wide methods of a kind are saved.
export async function countMethods(
  orgId: string,
  kind: string
): Promise<number> {
  const sql = getDbConnection();
  try {
    const [row] = await sql`
      SELECT count(*)::int AS n FROM alert_methods
      WHERE organization_id = ${orgId} AND workflow_id IS NULL AND kind = ${kind}
    `;
    return row.n as number;
  } finally {
    await sql.end();
  }
}
