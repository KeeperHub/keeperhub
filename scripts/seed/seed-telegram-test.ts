/**
 * Seed a one-action Telegram test workflow for the local dev user.
 *
 * Used to verify the lib/credential-fetcher.ts fix end-to-end: ensures the
 * step bundle resolves credentials.TELEGRAM_BOT_TOKEN via the static
 * PLUGIN_CREDENTIAL_MAP (lib/credential-map.ts) instead of the previous
 * lossy raw-config fallback.
 *
 * Prerequisites:
 *   pnpm tsx scripts/seed/seed-user.ts
 *   then sign in once at the local dev server so the org auto-creates.
 *
 * Usage:
 *   pnpm tsx scripts/seed/seed-telegram-test.ts
 *   (set SEED_EMAIL to override; defaults to dev@keeperhub.local)
 *
 * After seeding:
 *   1. Open the printed workflow URL.
 *   2. Add a Telegram integration via the connections UI with your bot token.
 *   3. On the workflow's Send Telegram Message node, select that integration
 *      and set Chat ID + Message.
 *   4. Run the workflow and confirm the message lands in Telegram.
 */

import "dotenv/config";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { getDatabaseUrl } from "../../lib/db/connection-utils";
import { member, users, workflows } from "../../lib/db/schema";
import { generateId } from "../../lib/utils/id";

const DEV_EMAIL = process.env.SEED_EMAIL ?? "dev@keeperhub.local";
const WORKFLOW_NAME = "Telegram credential-fetcher test";

const connectionString = getDatabaseUrl();
const client = postgres(connectionString, { max: 1 });
const db = drizzle(client);

const NODES = [
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
    id: "telegram-1",
    type: "action",
    position: { x: 400, y: 200 },
    data: {
      label: "Send Telegram Message",
      description:
        "Send a fixed message via the user's Telegram bot integration",
      type: "action",
      config: {
        actionType: "telegram/send-message",
        // integrationId left blank: bind via UI after creating the integration
        chatId: "",
        message: "Hello from KeeperHub local seed.",
        parseMode: "none",
      },
      status: "idle",
    },
  },
];

const EDGES = [{ id: "e1", source: "trigger-1", target: "telegram-1" }];

async function seed(): Promise<void> {
  const existingUser = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, DEV_EMAIL))
    .limit(1);

  if (!existingUser[0]) {
    console.error(
      `User "${DEV_EMAIL}" not found. Run 'pnpm tsx scripts/seed/seed-user.ts' first, or set SEED_EMAIL.`
    );
    process.exit(1);
  }
  const userId = existingUser[0].id;

  const existingMember = await db
    .select({ organizationId: member.organizationId })
    .from(member)
    .where(eq(member.userId, userId))
    .limit(1);

  if (!existingMember[0]) {
    console.error(
      `User "${DEV_EMAIL}" has no organization. Sign in via the UI once to auto-create it, then re-run this script.`
    );
    process.exit(1);
  }
  const orgId = existingMember[0].organizationId;

  const existingWorkflow = await db
    .select({ id: workflows.id })
    .from(workflows)
    .where(eq(workflows.name, WORKFLOW_NAME))
    .limit(1);

  if (existingWorkflow[0]) {
    console.log(`Workflow already exists: ${WORKFLOW_NAME}`);
    console.log(
      `   http://localhost:3000/workflows/${existingWorkflow[0].id}`
    );
    await client.end();
    return;
  }

  const id = generateId();
  const now = new Date();
  await db.insert(workflows).values({
    id,
    name: WORKFLOW_NAME,
    description:
      "Single Send Telegram Message node behind a manual trigger. Bind a Telegram integration in the UI to test the credential-fetcher fix.",
    userId,
    organizationId: orgId,
    nodes: NODES,
    edges: EDGES,
    visibility: "private",
    enabled: true,
    createdAt: now,
    updatedAt: now,
  });

  console.log(`User: ${DEV_EMAIL} (${userId})`);
  console.log(`Org:  ${orgId}`);
  console.log(`Workflow created: ${WORKFLOW_NAME}`);
  console.log(`   http://localhost:3000/workflows/${id}`);
  console.log("Next: sign in, add a Telegram integration, bind it on the");
  console.log("Send Telegram Message node, then run.");

  await client.end();
}

seed().catch(async (err: unknown) => {
  console.error("Seed failed:", err);
  await client.end();
  process.exit(1);
});
