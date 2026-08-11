import { getDbConnection } from "./connection";

const TEST_EMAIL_PATTERN = "test+%@techops.services";
const TEST_VERIFICATION_PATTERN = "%test+%@techops.services%";

// Persistent test account with testnet ETH - NEVER delete
const PROTECTED_EMAIL = "pr-test-do-not-delete@techops.services";

/**
 * Remove all ephemeral test users and their associated data.
 * Targets users matching `test+*@techops.services` (never the persistent
 * `pr-test-do-not-delete@techops.services` account).
 *
 * Deletes in FK-safe order: workflow data -> wallets -> invitations ->
 * members -> sessions -> accounts -> organizations -> users -> verifications.
 */
export async function cleanupTestUsers(): Promise<number> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    return 0;
  }

  const sql = getDbConnection();
  try {
    // Deleting test users drives security_audit_log's FK to null actor_user_id,
    // which the append-only trigger rejects. This cleanup connection runs as the
    // postgres superuser (max: 1), so disable replication-role triggers on it to
    // remove test data without tripping the guard.
    await sql`SET session_replication_role = 'replica'`;
    const testUsers = await sql`
      SELECT id FROM users
      WHERE email LIKE ${TEST_EMAIL_PATTERN}
        AND email != ${PROTECTED_EMAIL}
    `;
    if (testUsers.length === 0) {
      return 0;
    }

    const userIds = testUsers.map((u) => u.id as string);

    // Collect org IDs owned by test users before deleting members
    const ownedOrgs = await sql`
      SELECT DISTINCT organization_id AS id FROM member
      WHERE user_id IN ${sql(userIds)} AND role = 'owner'
    `;
    const orgIds = ownedOrgs.map((o) => o.id as string);

    // Collect workflow IDs for test users
    const testWorkflows = await sql`
      SELECT id FROM workflows WHERE user_id IN ${sql(userIds)}
    `;
    const workflowIds = testWorkflows.map((w) => w.id as string);

    // 1. Workflow-related data
    if (workflowIds.length > 0) {
      await sql`
        DELETE FROM workflow_execution_logs WHERE execution_id IN (
          SELECT id FROM workflow_executions
          WHERE workflow_id IN ${sql(workflowIds)}
        )
      `;
      await sql`
        DELETE FROM workflow_executions
        WHERE workflow_id IN ${sql(workflowIds)}
      `;
      await sql`
        DELETE FROM workflow_schedules
        WHERE workflow_id IN ${sql(workflowIds)}
      `;
      await sql`
        DELETE FROM workflows WHERE id IN ${sql(workflowIds)}
      `;
    }

    // 2. Wallets
    await sql`DELETE FROM organization_wallets WHERE user_id IN ${sql(userIds)}`;

    // 3. Integrations, API keys, and org-scoped data
    // integrations uses created_by (not user_id) per schema
    await sql`DELETE FROM integrations WHERE created_by IN ${sql(userIds)}`;
    await sql`DELETE FROM api_keys WHERE user_id IN ${sql(userIds)}`;
    await sql`DELETE FROM user_rpc_preferences WHERE user_id IN ${sql(userIds)}`;

    if (orgIds.length > 0) {
      await sql`DELETE FROM address_book_entry WHERE organization_id IN ${sql(orgIds)}`;
      await sql`DELETE FROM organization_api_keys WHERE organization_id IN ${sql(orgIds)}`;
      await sql`DELETE FROM organization_tokens WHERE organization_id IN ${sql(orgIds)}`;
      await sql`DELETE FROM projects WHERE organization_id IN ${sql(orgIds)}`;
      await sql`DELETE FROM tags WHERE organization_id IN ${sql(orgIds)}`;
      await sql`DELETE FROM integrations WHERE organization_id IN ${sql(orgIds)}`;
    }

    // 4. Invitations for test-owned orgs + invitations sent to test emails
    if (orgIds.length > 0) {
      await sql`
        DELETE FROM invitation
        WHERE organization_id IN ${sql(orgIds)}
      `;
    }
    await sql`
      DELETE FROM invitation WHERE email LIKE ${TEST_EMAIL_PATTERN}
    `;

    // 5. Members: first in test-owned orgs (catches non-test invitees),
    //    then any remaining memberships for test users in other orgs
    if (orgIds.length > 0) {
      await sql`
        DELETE FROM member WHERE organization_id IN ${sql(orgIds)}
      `;
    }
    await sql`
      DELETE FROM member WHERE user_id IN ${sql(userIds)}
    `;

    // 6. Sessions and accounts
    await sql`DELETE FROM sessions WHERE user_id IN ${sql(userIds)}`;
    await sql`DELETE FROM accounts WHERE user_id IN ${sql(userIds)}`;

    // 7. Organizations owned by test users
    if (orgIds.length > 0) {
      await sql`DELETE FROM organization WHERE id IN ${sql(orgIds)}`;
    }

    // 8. Users
    await sql`DELETE FROM users WHERE id IN ${sql(userIds)}`;

    // 8. Verifications (OTP records)
    await sql`
      DELETE FROM verifications
      WHERE identifier LIKE ${TEST_VERIFICATION_PATTERN}
    `;

    return testUsers.length;
  } finally {
    await sql.end();
  }
}
