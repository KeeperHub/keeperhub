/**
 * Seed script for testing the workflow listing UI (Phase 26).
 * Creates workflows in various listing states:
 * - Unlisted (default) -- for testing the listing flow
 * - Listed with schema and price -- for testing the listed state
 * - Listed free ($0) -- for testing free workflow behavior
 *
 * Usage: pnpm tsx scripts/seed/seed-listing-workflows.ts
 *
 * Prerequisites: Sign in via the UI first so the seed user has an org.
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

type ListingWorkflowDef = {
  name: string;
  description: string;
  isListed: boolean;
  listedSlug: string | null;
  listedAt: Date | null;
  inputSchema: Record<string, unknown> | null;
  outputMapping: Record<string, unknown> | null;
  priceUsdcPerCall: string | null;
  nodes: unknown[];
  edges: unknown[];
};

function buildWorkflows(): ListingWorkflowDef[] {
  const now = new Date();

  return [
    // 1. Unlisted workflow -- test listing flow from scratch
    {
      name: "Token Price Monitor",
      description:
        "Monitors ERC-20 token prices and sends alerts when thresholds are crossed. Good candidate for listing as an agent-callable service.",
      isListed: false,
      listedSlug: null,
      listedAt: null,
      inputSchema: null,
      outputMapping: null,
      priceUsdcPerCall: null,
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
          id: "price-1",
          type: "action",
          position: { x: 350, y: 200 },
          data: {
            label: "Get Token Price",
            description: "Fetch current price for a token",
            type: "action",
            config: { actionType: "web3/get-token-price", network: "1" },
            status: "idle",
          },
        },
        {
          id: "condition-1",
          type: "action",
          position: { x: 600, y: 200 },
          data: {
            label: "Price Below Threshold?",
            description: "Check if price dropped below target",
            type: "action",
            config: {
              actionType: "Condition",
              condition:
                '{{@price-1:Get Token Price.price}} < {{@trigger-1:Manual Trigger.threshold}}',
            },
            status: "idle",
          },
        },
        {
          id: "notify-1",
          type: "action",
          position: { x: 850, y: 200 },
          data: {
            label: "Send Alert",
            description: "Send price alert notification",
            type: "action",
            config: { actionType: "sendgrid/send-email" },
            status: "idle",
          },
        },
      ],
      edges: [
        { id: "e1", source: "trigger-1", target: "price-1" },
        { id: "e2", source: "price-1", target: "condition-1" },
        { id: "e3", source: "condition-1", target: "notify-1" },
      ],
    },

    // 2. Listed workflow with full schema and paid price
    {
      name: "Smart Contract Auditor",
      description:
        "AI-powered smart contract security audit. Analyzes bytecode for common vulnerabilities including reentrancy, integer overflow, and access control issues. Returns a detailed risk report with severity ratings.",
      isListed: true,
      listedSlug: "smart-contract-auditor",
      listedAt: now,
      inputSchema: {
        type: "object",
        properties: {
          contractAddress: {
            type: "string",
            description: "The contract address to audit (0x...)",
          },
          network: {
            type: "string",
            description: "Chain ID (1 for Ethereum, 8453 for Base)",
          },
          auditDepth: {
            type: "string",
            description: "Audit depth: quick, standard, or deep",
          },
        },
        required: ["contractAddress", "network"],
      },
      outputMapping: {
        nodeId: "audit-1",
        fields: ["riskScore", "vulnerabilities", "recommendation"],
      },
      priceUsdcPerCall: "0.50",
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
          id: "bytecode-1",
          type: "action",
          position: { x: 350, y: 200 },
          data: {
            label: "Get Bytecode",
            description: "Fetch contract bytecode from chain",
            type: "action",
            config: { actionType: "web3/get-bytecode", network: "1" },
            status: "idle",
          },
        },
        {
          id: "audit-1",
          type: "action",
          position: { x: 600, y: 200 },
          data: {
            label: "AI Audit",
            description: "Run AI security analysis on the bytecode",
            type: "action",
            config: { actionType: "web3/assess-risk" },
            status: "idle",
          },
        },
      ],
      edges: [
        { id: "e1", source: "trigger-1", target: "bytecode-1" },
        { id: "e2", source: "bytecode-1", target: "audit-1" },
      ],
    },

    // 3. Listed free workflow ($0)
    {
      name: "Gas Price Oracle",
      description:
        "Returns current gas prices across multiple chains. Free to call -- useful as a utility service for other agents.",
      isListed: true,
      listedSlug: "gas-price-oracle",
      listedAt: now,
      inputSchema: {
        type: "object",
        properties: {
          networks: {
            type: "string",
            description: "Comma-separated chain IDs (e.g. 1,8453,42161)",
          },
        },
        required: ["networks"],
      },
      outputMapping: {
        nodeId: "gas-1",
        fields: ["gasPrices"],
      },
      priceUsdcPerCall: "0",
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
          id: "gas-1",
          type: "action",
          position: { x: 350, y: 200 },
          data: {
            label: "Fetch Gas Prices",
            description: "Get gas prices for requested networks",
            type: "action",
            config: { actionType: "web3/get-gas-price" },
            status: "idle",
          },
        },
      ],
      edges: [{ id: "e1", source: "trigger-1", target: "gas-1" }],
    },

    // 4. Unlisted workflow with complex nodes -- tests output mapping with multiple action nodes
    {
      name: "DeFi Position Tracker",
      description:
        "Tracks a wallet's DeFi positions across Aave, Compound, and Uniswap. Calculates total portfolio value and health factor.",
      isListed: false,
      listedSlug: null,
      listedAt: null,
      inputSchema: null,
      outputMapping: null,
      priceUsdcPerCall: null,
      nodes: [
        {
          id: "trigger-1",
          type: "trigger",
          position: { x: 100, y: 300 },
          data: {
            label: "Manual Trigger",
            type: "trigger",
            config: { triggerType: "Manual" },
            status: "idle",
          },
        },
        {
          id: "aave-1",
          type: "action",
          position: { x: 350, y: 150 },
          data: {
            label: "Check Aave Position",
            description: "Fetch Aave lending positions",
            type: "action",
            config: { actionType: "web3/read-contract", network: "1" },
            status: "idle",
          },
        },
        {
          id: "compound-1",
          type: "action",
          position: { x: 350, y: 300 },
          data: {
            label: "Check Compound Position",
            description: "Fetch Compound lending positions",
            type: "action",
            config: { actionType: "web3/read-contract", network: "1" },
            status: "idle",
          },
        },
        {
          id: "uniswap-1",
          type: "action",
          position: { x: 350, y: 450 },
          data: {
            label: "Check Uniswap LP",
            description: "Fetch Uniswap V3 LP positions",
            type: "action",
            config: { actionType: "web3/read-contract", network: "1" },
            status: "idle",
          },
        },
        {
          id: "aggregate-1",
          type: "action",
          position: { x: 600, y: 300 },
          data: {
            label: "Aggregate Portfolio",
            description: "Calculate total value and health factor",
            type: "action",
            config: { actionType: "web3/assess-risk" },
            status: "idle",
          },
        },
      ],
      edges: [
        { id: "e1", source: "trigger-1", target: "aave-1" },
        { id: "e2", source: "trigger-1", target: "compound-1" },
        { id: "e3", source: "trigger-1", target: "uniswap-1" },
        { id: "e4", source: "aave-1", target: "aggregate-1" },
        { id: "e5", source: "compound-1", target: "aggregate-1" },
        { id: "e6", source: "uniswap-1", target: "aggregate-1" },
      ],
    },
  ];
}

async function seed(): Promise<void> {
  console.log("Seeding listing test workflows...\n");

  // 1. Find user
  const userRows = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.email, DEV_EMAIL))
    .limit(1);

  if (!userRows[0]) {
    console.error(
      `User "${DEV_EMAIL}" not found. Sign in via the UI first, or set SEED_EMAIL.`
    );
    process.exit(1);
  }

  const userId = userRows[0].id;
  console.log(`  User: ${DEV_EMAIL} (${userId})`);

  // 2. Find org
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
  console.log(`  Organization: ${orgId}\n`);

  // 3. Create workflows
  const workflowDefs = buildWorkflows();
  const now = new Date();

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
        featured: false,
        enabled: true,
        isListed: def.isListed,
        listedSlug: def.listedSlug,
        listedAt: def.listedAt,
        inputSchema: def.inputSchema,
        outputMapping: def.outputMapping,
        priceUsdcPerCall: def.priceUsdcPerCall,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();

    const status = def.isListed
      ? `LISTED (${def.listedSlug}, $${def.priceUsdcPerCall}/call)`
      : "unlisted";
    console.log(`  + ${def.name} [${status}]`);
    console.log(`    http://localhost:3000/workflows/${id}`);
  }

  console.log(
    `\nDone! Created ${workflowDefs.length} workflows for listing UI testing.`
  );
  console.log("\nTest scenarios:");
  console.log(
    "  1. Token Price Monitor -- unlisted, test full listing flow from scratch"
  );
  console.log(
    "  2. Smart Contract Auditor -- listed ($0.50/call), test listed state and immutable slug"
  );
  console.log(
    "  3. Gas Price Oracle -- listed free ($0/call), test free workflow listing"
  );
  console.log(
    "  4. DeFi Position Tracker -- unlisted with multiple action nodes, test output mapping selector"
  );

  await client.end();
  process.exit(0);
}

seed().catch(async (err: unknown) => {
  console.error("Seed failed:", err);
  await client.end();
  process.exit(1);
});
