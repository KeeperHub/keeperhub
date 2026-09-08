/**
 * E2E regression test for credential resolution inside Workflow DevKit step bundles.
 *
 * Background: between 2026-03-13 and 2026-04-28 the credential fetcher's
 * fallback (lib/credential-fetcher.ts ca226048) silently returned raw
 * configKey-keyed credentials when the runtime plugin registry was unreachable
 * - which is the case inside step bundles. Plugins where configKey != envVar
 * (Telegram, Slack) failed at runtime with messages like "Telegram bot token
 * is required" because the step's credentials.<envVar> read returned
 * undefined. Discord happened to work because its configKey matches its
 * envVar (webhookUrl == webhookUrl), but it's included here as a control to
 * prove the fix doesn't regress the previously-working path.
 *
 * SendGrid is intentionally not covered here. By design, every workflow
 * sends email through KeeperHub's platform-managed SENDGRID_API_KEY; the
 * step (plugins/sendgrid/steps/send-email.ts) uses process.env directly and
 * does not read integration credentials at runtime. The credential-fetcher
 * bug class therefore cannot affect SendGrid in production. The unit test
 * in tests/unit/credential-fetcher.test.ts still pins SendGrid's
 * configKey/envVar mapping in case the platform-managed model ever changes.
 *
 * The unit tests in tests/unit/credential-fetcher* pin the static map's
 * correctness, but cannot prove the bundler actually ships it. This test
 * exercises the real prod execution path: start a workflow run via
 * POST /api/workflow/{id}/execute, let it run through the step bundle, and
 * assert the failure mode is downstream of the credential gate.
 */

import { createCipheriv, randomBytes } from "node:crypto";
import postgres from "postgres";
import { expect, test } from "./fixtures";
import {
  deleteTestWorkflow,
  PERSISTENT_TEST_USER_EMAIL,
  waitForWorkflowExecution,
} from "./utils/db";

const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const ENCRYPTION_IV_LENGTH = 16;

type CleanupHandle = {
  workflowId: string;
  integrationId: string;
};

type CommsCase = {
  name: string;
  integrationType: string;
  integrationLabel: string;
  configKey: string;
  buildConfigValue: () => string;
  actionType: string;
  buildActionConfig: () => Record<string, unknown>;
  /**
   * Regex matching the local "credential is required" guard error message.
   * If this regex matches the run's error, the credential never reached the
   * step - that is the regression we are catching.
   */
  localGuardErrorRe: RegExp;
};

const COMMS_CASES: CommsCase[] = [
  {
    name: "telegram",
    integrationType: "telegram",
    integrationLabel: "Telegram (e2e bundle test)",
    configKey: "botToken",
    buildConfigValue: () =>
      `${randomBytes(4).readUInt32BE(0)}:e2e_invalid_token_${randomBytes(8).toString("hex")}`,
    actionType: "telegram/send-message",
    buildActionConfig: () => ({
      chatId: "999999999",
      message: "credential-bundle e2e probe",
      parseMode: "none",
    }),
    localGuardErrorRe: /Telegram bot token is required/i,
  },
  {
    name: "slack",
    integrationType: "slack",
    integrationLabel: "Slack (e2e bundle test)",
    configKey: "apiKey",
    buildConfigValue: () =>
      `xoxb-e2e-invalid-${randomBytes(8).toString("hex")}`,
    actionType: "slack/send-message",
    buildActionConfig: () => ({
      slackChannel: "#nonexistent-e2e-channel",
      slackMessage: "credential-bundle e2e probe",
    }),
    localGuardErrorRe: /SLACK_API_KEY is not configured/i,
  },
  {
    name: "discord",
    integrationType: "discord",
    integrationLabel: "Discord (e2e bundle test)",
    configKey: "webhookUrl",
    // Well-formed Discord webhook URL shape; the step's format check
    // requires "discord.com/api/webhooks/" in the value.
    buildConfigValue: () =>
      `https://discord.com/api/webhooks/999999999999999999/e2e_invalid_token_${randomBytes(8).toString("hex")}`,
    actionType: "discord/send-message",
    buildActionConfig: () => ({
      discordMessage: "credential-bundle e2e probe",
    }),
    localGuardErrorRe: /Discord webhook URL is required/i,
  },
];

function getDb(): ReturnType<typeof postgres> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is required for this test");
  }
  return postgres(url, { max: 1 });
}

function generateId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 12; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Encrypt the integration config the same way lib/db/integrations.ts does.
 * Format: iv:authTag:ciphertext (all hex).
 */
function encryptConfig(config: Record<string, unknown>): string {
  const keyHex = process.env.INTEGRATION_ENCRYPTION_KEY;
  if (keyHex?.length !== 64) {
    throw new Error(
      "INTEGRATION_ENCRYPTION_KEY must be a 64-char hex string for this test"
    );
  }
  const key = Buffer.from(keyHex, "hex");
  const iv = randomBytes(ENCRYPTION_IV_LENGTH);
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  const plaintext = JSON.stringify(config);
  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted}`;
}

async function lookupUserAndOrg(
  email: string
): Promise<{ userId: string; organizationId: string }> {
  const sql = getDb();
  try {
    const userRows = await sql`
      SELECT id FROM users WHERE email = ${email}
    `;
    if (userRows.length === 0) {
      throw new Error(`Test user "${email}" not found - seed it first`);
    }
    const userId = userRows[0].id as string;

    const memberRows = await sql`
      SELECT organization_id FROM member WHERE user_id = ${userId} LIMIT 1
    `;
    if (memberRows.length === 0) {
      throw new Error(
        `Test user "${email}" has no organization - sign in once via UI`
      );
    }
    return {
      userId,
      organizationId: memberRows[0].organization_id as string,
    };
  } finally {
    await sql.end();
  }
}

async function createIntegration(options: {
  userId: string;
  organizationId: string;
  type: string;
  label: string;
  config: Record<string, unknown>;
}): Promise<string> {
  const sql = getDb();
  try {
    const id = generateId();
    const encryptedConfig = encryptConfig(options.config);
    const now = new Date();
    // visibility must be 'organization': workflow execution authorizes as the
    // org principal (isIntegrationUsable), and a 'private' integration -- the
    // column default -- is never usable for the org principal, which surfaces
    // as a 403 "invalid integration references" at the execute gate.
    await sql`
      INSERT INTO integrations (
        id, created_by, organization_id, name, type, config, visibility, created_at, updated_at
      ) VALUES (
        ${id},
        ${options.userId},
        ${options.organizationId},
        ${options.label},
        ${options.type},
        ${encryptedConfig},
        'organization',
        ${now},
        ${now}
      )
    `;
    return id;
  } finally {
    await sql.end();
  }
}

async function deleteIntegration(integrationId: string): Promise<void> {
  const sql = getDb();
  try {
    await sql`DELETE FROM integrations WHERE id = ${integrationId}`;
  } finally {
    await sql.end();
  }
}

async function createWorkflowWithAction(options: {
  userId: string;
  organizationId: string;
  integrationId: string;
  actionType: string;
  actionConfig: Record<string, unknown>;
  workflowName: string;
}): Promise<string> {
  const sql = getDb();
  try {
    const workflowId = generateId();
    const nodes = [
      {
        id: "trigger-1",
        type: "trigger",
        position: { x: 100, y: 200 },
        data: {
          label: "Manual Trigger",
          type: "trigger",
          config: { triggerType: "Manual" },
          status: "idle",
        },
      },
      {
        id: "action-1",
        type: "action",
        position: { x: 400, y: 200 },
        data: {
          label: options.workflowName,
          type: "action",
          config: {
            actionType: options.actionType,
            integrationId: options.integrationId,
            ...options.actionConfig,
          },
          status: "idle",
        },
      },
    ];
    const edges = [{ id: "e1", source: "trigger-1", target: "action-1" }];
    const now = new Date();
    await sql.unsafe(
      `INSERT INTO workflows (
        id, name, description, user_id, organization_id, is_anonymous,
        nodes, edges, visibility, enabled, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, false, $6::jsonb, $7::jsonb, 'private', true, $8, $9
      )`,
      [
        workflowId,
        options.workflowName,
        "Verifies credential plumbing through the Workflow DevKit step bundle.",
        options.userId,
        options.organizationId,
        JSON.stringify(nodes),
        JSON.stringify(edges),
        now,
        now,
      ]
    );
    return workflowId;
  } finally {
    await sql.end();
  }
}

async function safeCleanup(handle: CleanupHandle | null): Promise<void> {
  if (!handle) {
    return;
  }
  await deleteTestWorkflow(handle.workflowId).catch(() => {
    /* best-effort */
  });
  await deleteIntegration(handle.integrationId).catch(() => {
    /* best-effort */
  });
}

test.describe("Credential resolution in workflow step bundles", () => {
  // These assertions require a workflow execution to run to completion (the
  // step makes a real outbound call, and we inspect how it failed). Under
  // `next dev` the Workflow DevKit worker does not advance runs -- they hang
  // at pending and the test times out -- so this suite only runs under the
  // production runtime, matching back-forward-hydration's NEXT_BUILD_MODE gate.
  test.skip(
    process.env.NEXT_BUILD_MODE !== "production",
    "Workflow execution only completes under the production runtime (NEXT_BUILD_MODE=production)."
  );
  for (const commsCase of COMMS_CASES) {
    test(`${commsCase.integrationType} step receives credentials via PLUGIN_CREDENTIAL_MAP, not the lossy fallback`, async ({
      apiRequest,
    }) => {
      const { userId, organizationId } = await lookupUserAndOrg(
        PERSISTENT_TEST_USER_EMAIL
      );

      // Use a well-formed but invalid credential. The upstream service
      // rejects with HTTP 4xx, which is the success signal: it proves the
      // credential reached the step and an outbound request was actually
      // made. Before the fix, the step would short-circuit at the local
      // guard before any HTTP traffic.
      const credentialValue = commsCase.buildConfigValue();
      const integrationId = await createIntegration({
        userId,
        organizationId,
        type: commsCase.integrationType,
        label: commsCase.integrationLabel,
        config: { [commsCase.configKey]: credentialValue },
      });
      const workflowId = await createWorkflowWithAction({
        userId,
        organizationId,
        integrationId,
        actionType: commsCase.actionType,
        actionConfig: commsCase.buildActionConfig(),
        workflowName: `${commsCase.integrationType} credential bundle e2e`,
      });
      const cleanup: CleanupHandle = { workflowId, integrationId };

      try {
        const response = await apiRequest.post(
          `/api/workflow/${workflowId}/execute`,
          { data: {} }
        );
        expect(
          response.ok(),
          `expected 2xx from execute endpoint, got ${response.status()} ${response.statusText()}: ${await response.text()}`
        ).toBeTruthy();

        const result = await waitForWorkflowExecution(workflowId, 90_000);
        expect(
          result,
          "workflow execution did not complete in time"
        ).not.toBeNull();

        // The execution will fail (bad credential) - that's fine. What
        // matters is HOW it fails. If the static credential map is wired
        // correctly, the failure is an upstream API rejection. If the lossy
        // fallback is back, the failure is the local "credential required"
        // guard before any outbound HTTP call.
        if (result?.error) {
          expect(
            result.error,
            `step failed at the credential gate; static map regression for ${commsCase.integrationType}: ${result.error}`
          ).not.toMatch(commsCase.localGuardErrorRe);
        }
      } finally {
        await safeCleanup(cleanup);
      }
    });
  }

  // SendGrid is intentionally not covered. By design, every workflow sends
  // email through KeeperHub's platform-managed SENDGRID_API_KEY env var;
  // the step does not read integration credentials at runtime, so the
  // credential-fetcher bug class never applied to it.
});
