/**
 * Seed script for ERC-4626 vault workflows.
 * Creates test workflows for Sky (sUSDS) and Spark (sDAI) vault read actions.
 *
 * Usage: pnpm tsx scripts/seed/seed-erc4626-workflows.ts
 */

import "dotenv/config";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { getDatabaseUrl } from "../../lib/db/connection-utils";
import { member, users, workflows } from "../../lib/db/schema";
import { generateId } from "../../lib/utils/id";

const connectionString = getDatabaseUrl();
const client = postgres(connectionString, { max: 1 });
const db = drizzle(client);

const DEV_EMAIL = process.env.SEED_EMAIL ?? "dev@keeperhub.local";

// Known sUSDS holder on mainnet (Sky Treasury)
const SUSDS_HOLDER = "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD";
// Known sDAI holder on mainnet (sDAI contract itself holds DAI)
const SDAI_HOLDER = "0x83F20F44975D03b1b09e64809B757c47f942BEeA";

type WorkflowDef = {
  name: string;
  description: string;
  nodes: unknown[];
  edges: unknown[];
};

function buildWorkflows(): WorkflowDef[] {
  return [
    // 1. Sky sUSDS vault read monitor
    {
      name: "ERC-4626: Sky sUSDS Vault Monitor",
      description:
        "Read-only monitor for Sky sUSDS vault. Checks share balance, converts to underlying USDS value, and reads total vault assets.",
      nodes: [
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
          id: "sky-balance-1",
          type: "action",
          position: { x: 350, y: 200 },
          data: {
            label: "Check sUSDS Balance",
            description: "Get sUSDS share balance of an address",
            type: "action",
            config: {
              actionType: "sky/vault-balance",
              network: "1",
              account: SUSDS_HOLDER,
              _protocolMeta: JSON.stringify({
                protocolSlug: "sky",
                contractKey: "sUsds",
                functionName: "balanceOf",
                actionType: "read",
              }),
            },
            status: "idle",
          },
        },
        {
          id: "sky-convert-1",
          type: "action",
          position: { x: 600, y: 200 },
          data: {
            label: "Convert to USDS Value",
            description:
              "Convert sUSDS shares to underlying USDS value at current rate",
            type: "action",
            config: {
              actionType: "sky/vault-convert-to-assets",
              network: "1",
              shares: "{{@sky-balance-1:Check sUSDS Balance.balance}}",
              _protocolMeta: JSON.stringify({
                protocolSlug: "sky",
                contractKey: "sUsds",
                functionName: "convertToAssets",
                actionType: "read",
              }),
            },
            status: "idle",
          },
        },
        {
          id: "sky-total-1",
          type: "action",
          position: { x: 850, y: 200 },
          data: {
            label: "Total Vault Assets",
            description: "Get total USDS held in the sUSDS vault",
            type: "action",
            config: {
              actionType: "sky/vault-total-assets",
              network: "1",
              _protocolMeta: JSON.stringify({
                protocolSlug: "sky",
                contractKey: "sUsds",
                functionName: "totalAssets",
                actionType: "read",
              }),
            },
            status: "idle",
          },
        },
      ],
      edges: [
        { id: "e1", source: "trigger-1", target: "sky-balance-1" },
        { id: "e2", source: "sky-balance-1", target: "sky-convert-1" },
        { id: "e3", source: "sky-convert-1", target: "sky-total-1" },
      ],
    },

    // 2. Spark sDAI vault read monitor
    {
      name: "ERC-4626: Spark sDAI Vault Monitor",
      description:
        "Read-only monitor for Spark sDAI vault. Checks share balance, total vault assets, and converts shares to DAI value.",
      nodes: [
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
          id: "spark-balance-1",
          type: "action",
          position: { x: 350, y: 200 },
          data: {
            label: "Check sDAI Balance",
            description: "Get sDAI share balance of an address",
            type: "action",
            config: {
              actionType: "spark/vault-balance",
              network: "1",
              account: SDAI_HOLDER,
              _protocolMeta: JSON.stringify({
                protocolSlug: "spark",
                contractKey: "sdai",
                functionName: "balanceOf",
                actionType: "read",
              }),
            },
            status: "idle",
          },
        },
        {
          id: "spark-total-1",
          type: "action",
          position: { x: 600, y: 100 },
          data: {
            label: "Total sDAI Vault Assets",
            description: "Get total DAI held in the sDAI vault",
            type: "action",
            config: {
              actionType: "spark/vault-total-assets",
              network: "1",
              _protocolMeta: JSON.stringify({
                protocolSlug: "spark",
                contractKey: "sdai",
                functionName: "totalAssets",
                actionType: "read",
              }),
            },
            status: "idle",
          },
        },
        {
          id: "spark-convert-1",
          type: "action",
          position: { x: 600, y: 300 },
          data: {
            label: "Convert sDAI to DAI Value",
            description:
              "Convert sDAI shares to their underlying DAI value at current DSR rate",
            type: "action",
            config: {
              actionType: "spark/vault-convert-to-assets",
              network: "1",
              shares: "{{@spark-balance-1:Check sDAI Balance.balance}}",
              _protocolMeta: JSON.stringify({
                protocolSlug: "spark",
                contractKey: "sdai",
                functionName: "convertToAssets",
                actionType: "read",
              }),
            },
            status: "idle",
          },
        },
      ],
      edges: [
        { id: "e1", source: "trigger-1", target: "spark-balance-1" },
        { id: "e2", source: "spark-balance-1", target: "spark-total-1" },
        { id: "e3", source: "spark-balance-1", target: "spark-convert-1" },
      ],
    },

    // 3. Sky vault metadata reader (tests additional ERC-4626 read actions)
    {
      name: "ERC-4626: Sky Vault Metadata",
      description:
        "Reads Sky sUSDS vault metadata: underlying asset address, total supply, preview deposit, and max deposit.",
      nodes: [
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
          id: "sky-asset-1",
          type: "action",
          position: { x: 350, y: 100 },
          data: {
            label: "Underlying Asset",
            description: "Get the underlying asset (USDS) address of the vault",
            type: "action",
            config: {
              actionType: "sky/vault-asset",
              network: "1",
              _protocolMeta: JSON.stringify({
                protocolSlug: "sky",
                contractKey: "sUsds",
                functionName: "asset",
                actionType: "read",
              }),
            },
            status: "idle",
          },
        },
        {
          id: "sky-supply-1",
          type: "action",
          position: { x: 350, y: 300 },
          data: {
            label: "Total Share Supply",
            description: "Get total sUSDS shares in circulation",
            type: "action",
            config: {
              actionType: "sky/vault-total-supply",
              network: "1",
              _protocolMeta: JSON.stringify({
                protocolSlug: "sky",
                contractKey: "sUsds",
                functionName: "totalSupply",
                actionType: "read",
              }),
            },
            status: "idle",
          },
        },
        {
          id: "sky-preview-1",
          type: "action",
          position: { x: 600, y: 100 },
          data: {
            label: "Preview 1000 USDS Deposit",
            description: "Preview how many sUSDS shares 1000 USDS would yield",
            type: "action",
            config: {
              actionType: "sky/vault-preview-deposit",
              network: "1",
              assets: "1000000000000000000000",
              _protocolMeta: JSON.stringify({
                protocolSlug: "sky",
                contractKey: "sUsds",
                functionName: "previewDeposit",
                actionType: "read",
              }),
            },
            status: "idle",
          },
        },
        {
          id: "sky-max-1",
          type: "action",
          position: { x: 600, y: 300 },
          data: {
            label: "Max Deposit",
            description: "Get the maximum deposit amount for a receiver",
            type: "action",
            config: {
              actionType: "sky/vault-max-deposit",
              network: "1",
              receiver: SUSDS_HOLDER,
              _protocolMeta: JSON.stringify({
                protocolSlug: "sky",
                contractKey: "sUsds",
                functionName: "maxDeposit",
                actionType: "read",
              }),
            },
            status: "idle",
          },
        },
      ],
      edges: [
        { id: "e1", source: "trigger-1", target: "sky-asset-1" },
        { id: "e2", source: "trigger-1", target: "sky-supply-1" },
        { id: "e3", source: "sky-asset-1", target: "sky-preview-1" },
        { id: "e4", source: "sky-supply-1", target: "sky-max-1" },
      ],
    },
  ];
}

async function seed(): Promise<void> {
  console.log("Seeding ERC-4626 vault test workflows...\n");

  const now = new Date();

  const existingUser = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, DEV_EMAIL))
    .limit(1);

  if (!existingUser[0]) {
    console.error(
      `User "${DEV_EMAIL}" not found. Run seed-user.ts first, or set SEED_EMAIL.`
    );
    process.exit(1);
  }

  const userId = existingUser[0].id;
  console.log(`  + User: ${DEV_EMAIL} (${userId})`);

  const existingMember = await db
    .select({ organizationId: member.organizationId })
    .from(member)
    .where(eq(member.userId, userId))
    .limit(1);

  if (!existingMember[0]) {
    console.error(
      `User "${DEV_EMAIL}" has no organization. Sign in via the UI first to auto-create one.`
    );
    process.exit(1);
  }

  const orgId = existingMember[0].organizationId;
  console.log(`  + Organization: ${orgId}\n`);

  const workflowDefs = buildWorkflows();
  const createdIds: string[] = [];

  for (const def of workflowDefs) {
    const id = generateId();
    await db
      .insert(workflows)
      .values({
        id,
        name: def.name,
        description: def.description,
        userId,
        organizationId: orgId,
        nodes: def.nodes,
        edges: def.edges,
        visibility: "private",
        enabled: true,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
    createdIds.push(id);
    console.log(`  + ${def.name}`);
    console.log(`    http://localhost:3000/workflows/${id}`);
  }

  console.log(
    `\nDone! Created ${createdIds.length} ERC-4626 vault test workflows.`
  );

  await client.end();
  process.exit(0);
}

seed().catch(async (err: unknown) => {
  console.error("Seed failed:", err);
  await client.end();
  process.exit(1);
});
