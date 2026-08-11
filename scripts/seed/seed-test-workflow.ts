/**
 * Seed script for local testing of security workflow templates.
 * Creates a test user, org, and multiple security workflows.
 *
 * Usage: pnpm tsx scripts/seed-test-workflow.ts
 */

import "dotenv/config";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { getDatabaseUrl } from "../../lib/db/connection-utils";
import {
  member,
  publicTags,
  users,
  workflowPublicTags,
  workflows,
} from "../../lib/db/schema";
import { generateId } from "../../lib/utils/id";

const SEED_TAGS = [
  { name: "Security", slug: "security" },
  { name: "DeFi", slug: "defi" },
  { name: "Monitoring", slug: "monitoring" },
  { name: "Alerts", slug: "alerts" },
  { name: "Treasury", slug: "treasury" },
] as const;

const WORKFLOW_TAGS: Record<string, string[]> = {
  "Security: Transaction Risk Scanner": ["Security", "DeFi", "Monitoring"],
  "Security: Unlimited Approval Detector": ["Security", "DeFi", "Alerts"],
  "Security: Ownership Transfer Alert": [
    "Security",
    "Alerts",
    "Monitoring",
    "DeFi",
  ],
  "Security: Treasury Balance Monitor": [
    "Monitoring",
    "Treasury",
    "Alerts",
    "Security",
    "DeFi",
  ],
  "Security: Low-Risk Baseline (ERC-20 Transfer)": ["Security", "DeFi"],
};

const connectionString = getDatabaseUrl();
const client = postgres(connectionString, { max: 1 });
const db = drizzle(client);

const DEV_EMAIL = process.env.SEED_EMAIL ?? "dev@keeperhub.local";

// Known mainnet transactions for testing
const USDT_TRANSFER_CALLDATA =
  "0xa9059cbb000000000000000000000000dac17f958d2ee523a2206206994597c13d831ec700000000000000000000000000000000000000000000000000000000003d0900";

// Unlimited approval: approve(spender, MAX_UINT256)
const UNLIMITED_APPROVAL_CALLDATA =
  "0x095ea7b30000000000000000000000007a250d5630b4cf539739df2c5dacb4c659f2488dffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

// transferOwnership(newOwner) -- critical privileged op
const TRANSFER_OWNERSHIP_CALLDATA =
  "0xf2fde38b000000000000000000000000deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

type WorkflowDef = {
  name: string;
  description: string;
  nodes: unknown[];
  edges: unknown[];
};

function buildWorkflows(): WorkflowDef[] {
  return [
    // 1. Full security pipeline: Get Tx -> Decode -> Assess Risk
    {
      name: "Security: Transaction Risk Scanner",
      description:
        "Fetch a transaction by hash, decode its calldata, and run AI risk assessment. Tests the full Get Transaction -> Decode Calldata -> Assess Risk pipeline.",
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
          id: "get-tx-1",
          type: "action",
          position: { x: 350, y: 200 },
          data: {
            label: "Get Transaction",
            description: "Fetch full transaction details from Ethereum mainnet",
            type: "action",
            config: {
              actionType: "web3/get-transaction",
              network: "1",
              // DAI approve() call -- recent tx with meaningful calldata
              transactionHash:
                "0x135ade6349bd76094c4876baa3277d84229fe05f4ebe5e54fd12f8157e313e12",
            },
            status: "idle",
          },
        },
        {
          id: "decode-1",
          type: "action",
          position: { x: 600, y: 200 },
          data: {
            label: "Decode Calldata",
            description: "Decode the transaction input data",
            type: "action",
            config: {
              actionType: "web3/decode-calldata",
              calldata: "{{@get-tx-1:Get Transaction.input}}",
              contractAddress: "{{@get-tx-1:Get Transaction.to}}",
              network: "1",
            },
            status: "idle",
          },
        },
        {
          id: "risk-1",
          type: "action",
          position: { x: 850, y: 200 },
          data: {
            label: "Assess Risk",
            description: "AI-powered risk assessment",
            type: "action",
            config: {
              actionType: "web3/assess-risk",
              calldata: "{{@get-tx-1:Get Transaction.input}}",
              contractAddress: "{{@get-tx-1:Get Transaction.to}}",
              value: "{{@get-tx-1:Get Transaction.value}}",
              chain: "1",
              senderAddress: "{{@get-tx-1:Get Transaction.from}}",
            },
            status: "idle",
          },
        },
      ],
      edges: [
        { id: "e1", source: "trigger-1", target: "get-tx-1" },
        { id: "e2", source: "get-tx-1", target: "decode-1" },
        { id: "e3", source: "decode-1", target: "risk-1" },
      ],
    },

    // 2. Unlimited approval detection
    {
      name: "Security: Unlimited Approval Detector",
      description:
        "Detects unlimited token approvals (approve with MAX_UINT256). Tests assess-risk catching high-risk approval patterns.",
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
          id: "decode-1",
          type: "action",
          position: { x: 350, y: 200 },
          data: {
            label: "Decode Approval",
            description: "Decode the approve() calldata",
            type: "action",
            config: {
              actionType: "web3/decode-calldata",
              calldata: UNLIMITED_APPROVAL_CALLDATA,
              contractAddress: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
              network: "1",
            },
            status: "idle",
          },
        },
        {
          id: "risk-1",
          type: "action",
          position: { x: 600, y: 200 },
          data: {
            label: "Assess Risk",
            description: "Should flag as HIGH: unlimited approval",
            type: "action",
            config: {
              actionType: "web3/assess-risk",
              calldata: UNLIMITED_APPROVAL_CALLDATA,
              contractAddress: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
              chain: "1",
            },
            status: "idle",
          },
        },
        {
          id: "condition-1",
          type: "action",
          position: { x: 850, y: 200 },
          data: {
            label: "Is High Risk?",
            description: "Gate: only pass if risk is high or critical",
            type: "action",
            config: {
              actionType: "Condition",
              condition: "{{@risk-1:Assess Risk.riskScore}} >= 51",
            },
            status: "idle",
          },
        },
      ],
      edges: [
        { id: "e1", source: "trigger-1", target: "decode-1" },
        { id: "e2", source: "decode-1", target: "risk-1" },
        { id: "e3", source: "risk-1", target: "condition-1" },
      ],
    },

    // 3. Ownership transfer detection (critical)
    {
      name: "Security: Ownership Transfer Alert",
      description:
        "Detects transferOwnership() calls. Tests assess-risk catching CRITICAL privileged operations.",
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
          id: "risk-1",
          type: "action",
          position: { x: 350, y: 200 },
          data: {
            label: "Assess Risk",
            description:
              "Should flag as CRITICAL: transferOwnership is a privileged op",
            type: "action",
            config: {
              actionType: "web3/assess-risk",
              calldata: TRANSFER_OWNERSHIP_CALLDATA,
              contractAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
              value: "0",
              chain: "1",
            },
            status: "idle",
          },
        },
        {
          id: "condition-critical",
          type: "action",
          position: { x: 600, y: 100 },
          data: {
            label: "Is Critical?",
            description: "Gate: critical risk only",
            type: "action",
            config: {
              actionType: "Condition",
              condition: "{{@risk-1:Assess Risk.riskScore}} >= 76",
            },
            status: "idle",
          },
        },
        {
          id: "condition-elevated",
          type: "action",
          position: { x: 600, y: 300 },
          data: {
            label: "Is Elevated?",
            description: "Gate: medium or high risk",
            type: "action",
            config: {
              actionType: "Condition",
              condition:
                "{{@risk-1:Assess Risk.riskScore}} >= 26 && {{@risk-1:Assess Risk.riskScore}} < 76",
            },
            status: "idle",
          },
        },
      ],
      edges: [
        { id: "e1", source: "trigger-1", target: "risk-1" },
        { id: "e2", source: "risk-1", target: "condition-critical" },
        { id: "e3", source: "risk-1", target: "condition-elevated" },
      ],
    },

    // 4. Treasury balance monitor
    {
      name: "Security: Treasury Balance Monitor",
      description:
        "Checks ETH balance of a treasury address on a schedule. Alerts if balance drops below threshold. No security plugins needed -- tests Condition gating.",
      nodes: [
        {
          id: "trigger-1",
          type: "trigger",
          position: { x: 100, y: 200 },
          data: {
            label: "Every 15 Minutes",
            type: "trigger",
            config: {
              triggerType: "Schedule",
              scheduleCron: "*/15 * * * *",
            },
            status: "idle",
          },
        },
        {
          id: "balance-1",
          type: "action",
          position: { x: 350, y: 200 },
          data: {
            label: "Check Treasury Balance",
            description: "Check ETH balance of Ethereum Foundation",
            type: "action",
            config: {
              actionType: "web3/check-balance",
              network: "1",
              address: "0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe",
            },
            status: "idle",
          },
        },
        {
          id: "condition-low",
          type: "action",
          position: { x: 600, y: 200 },
          data: {
            label: "Balance Below 100 ETH?",
            description: "Gate: alert if treasury is running low",
            type: "action",
            config: {
              actionType: "Condition",
              condition: "{{@balance-1:Check Treasury Balance.balance}} < 100",
            },
            status: "idle",
          },
        },
      ],
      edges: [
        { id: "e1", source: "trigger-1", target: "balance-1" },
        { id: "e2", source: "balance-1", target: "condition-low" },
      ],
    },

    // 5. Safe/low-risk baseline -- normal ERC-20 transfer
    {
      name: "Security: Low-Risk Baseline (ERC-20 Transfer)",
      description:
        "Decodes and assesses a normal ERC-20 transfer. Should produce LOW risk. Use as baseline to verify assess-risk calibration.",
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
          id: "decode-1",
          type: "action",
          position: { x: 350, y: 200 },
          data: {
            label: "Decode Transfer",
            description: "Decode a standard ERC-20 transfer(address,uint256)",
            type: "action",
            config: {
              actionType: "web3/decode-calldata",
              calldata: USDT_TRANSFER_CALLDATA,
              contractAddress: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
              network: "1",
            },
            status: "idle",
          },
        },
        {
          id: "risk-1",
          type: "action",
          position: { x: 600, y: 200 },
          data: {
            label: "Assess Risk",
            description: "Should produce LOW risk for a normal transfer",
            type: "action",
            config: {
              actionType: "web3/assess-risk",
              calldata: USDT_TRANSFER_CALLDATA,
              contractAddress: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
              value: "0",
              chain: "1",
            },
            status: "idle",
          },
        },
      ],
      edges: [
        { id: "e1", source: "trigger-1", target: "decode-1" },
        { id: "e2", source: "decode-1", target: "risk-1" },
      ],
    },
  ];
}

async function seed(): Promise<void> {
  console.log("Seeding security workflow test templates...\n");

  const now = new Date();

  // 1. Look up existing dev user
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

  // 2. Look up user's organization
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

  // 5. Ensure public tags exist
  const tagIdByName = new Map<string, string>();
  for (const tag of SEED_TAGS) {
    const existing = await db
      .select({ id: publicTags.id })
      .from(publicTags)
      .where(eq(publicTags.slug, tag.slug))
      .limit(1);

    if (existing[0]) {
      tagIdByName.set(tag.name, existing[0].id);
      console.log(`  Tag exists: ${tag.name} (${existing[0].id})`);
    } else {
      const id = generateId();
      await db.insert(publicTags).values({
        id,
        name: tag.name,
        slug: tag.slug,
      });
      tagIdByName.set(tag.name, id);
      console.log(`  + Tag: ${tag.name} (${id})`);
    }
  }

  // 6. Workflows
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
        visibility: "public",
        featured: true,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
    createdIds.push(id);

    // Associate public tags
    const tagNames = WORKFLOW_TAGS[def.name] ?? [];
    for (const tagName of tagNames) {
      const tagId = tagIdByName.get(tagName);
      if (tagId) {
        await db
          .insert(workflowPublicTags)
          .values({ workflowId: id, publicTagId: tagId })
          .onConflictDoNothing();
      }
    }

    console.log(
      `  + ${def.name} (${tagNames.length} tags)`
    );
    console.log(`    http://localhost:3000/workflows/${id}`);
  }

  console.log(
    `\nDone! Created ${createdIds.length} security workflow templates with tags.`
  );

  await client.end();
  process.exit(0);
}

seed().catch(async (err: unknown) => {
  console.error("Seed failed:", err);
  await client.end();
  process.exit(1);
});
