import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { organization, workflows } from "@/lib/db/schema";

type Seed = {
  id: string;
  description: string;
  orgId: string;
  inputSchema: Record<string, unknown>;
  outputMapping: { nodeId: string; field: string };
};

const SEEDS: Seed[] = [
  {
    id: "wf_mcp_test_001",
    orgId: "org_demo_acme",
    description:
      "Performs a comprehensive contract risk audit by combining several on-chain data sources. Pulls live reserve data from Aave V3, cross-references the protocol's health factor against Chronicle oracle prices, and emits a normalized risk score downstream agents can consume to liquidate, rebalance, or hold a leveraged position.",
    inputSchema: {
      type: "object",
      properties: {
        contractAddress: {
          type: "string",
          description: "Aave V3 Pool address to audit (40-char EVM address).",
        },
        chainId: {
          type: "number",
          description: "Chain ID (1=Mainnet, 8453=Base, 42161=Arbitrum).",
        },
        threshold: {
          type: "number",
          description:
            "Optional health-factor threshold below which to flag risk.",
        },
      },
      required: ["contractAddress", "chainId"],
    },
    outputMapping: { nodeId: "node-risk-assess", field: "riskScore" },
  },
  {
    id: "uat-wf-1",
    orgId: "org_demo_helix",
    description:
      "Demo workflow used during user-acceptance testing. Echoes the supplied payload through a no-op pipeline so QA can verify the end-to-end x402 invocation path before promoting real listings.",
    inputSchema: {
      type: "object",
      properties: {
        payload: {
          type: "string",
          description: "Arbitrary string the workflow will echo back.",
        },
      },
      required: ["payload"],
    },
    outputMapping: { nodeId: "node-echo", field: "echoed" },
  },
  {
    id: "6ks6f4ywwxl0janc924sd",
    // The org owns every workflow now (organization_id is NOT NULL), so the
    // x402 echo seed gets its own demo org instead of the old null-org form.
    orgId: "org_demo_x402",
    description:
      "Returns the input as output. For testing x402 paid calls — the workflow charges on every invocation but performs no real work, making it the cheapest way to validate an agent's payment plumbing.",
    inputSchema: {
      type: "object",
      properties: {
        input: {
          type: "string",
          description: "Any value to echo back in the response.",
        },
      },
      required: ["input"],
    },
    outputMapping: { nodeId: "node-echo", field: "value" },
  },
];

const DEMO_ORGS: Array<{ id: string; name: string; slug: string }> = [
  { id: "org_demo_acme", name: "Acme Labs", slug: "acme-labs" },
  { id: "org_demo_helix", name: "Helix Research", slug: "helix-research" },
  { id: "org_demo_x402", name: "x402 Demo", slug: "x402-demo" },
];

async function main(): Promise<void> {
  for (const org of DEMO_ORGS) {
    await db
      .insert(organization)
      .values({
        id: org.id,
        name: org.name,
        slug: org.slug,
        createdAt: new Date(),
      })
      .onConflictDoNothing({ target: organization.slug });
  }

  for (const seed of SEEDS) {
    await db
      .update(workflows)
      .set({
        description: seed.description,
        inputSchema: seed.inputSchema,
        outputMapping: seed.outputMapping,
        organizationId: seed.orgId,
        isAnonymous: false,
      })
      .where(eq(workflows.id, seed.id));
  }

  const rows = await db
    .select({
      id: workflows.id,
      name: workflows.name,
      orgId: workflows.organizationId,
      hasInput: workflows.inputSchema,
      hasOutput: workflows.outputMapping,
    })
    .from(workflows)
    .where(inArray(workflows.id, SEEDS.map((s) => s.id)));
  for (const r of rows) {
    console.log({
      id: r.id,
      name: r.name,
      orgId: r.orgId,
      hasInput: r.hasInput !== null,
      hasOutput: r.hasOutput !== null,
    });
  }
  process.exit(0);
}

void main();
