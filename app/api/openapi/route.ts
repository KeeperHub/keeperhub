import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { workflows } from "@/lib/db/schema";
import { sanitizeDescription } from "@/lib/sanitize-description";
import { workflowNotDeleted } from "@/lib/workflow/soft-delete";

export const dynamic = "force-dynamic";

const TRAILING_SLASH = /\/$/;

function deriveBaseUrl(request: Request): string {
  const envUrl = process.env.NEXT_PUBLIC_APP_URL ?? process.env.BETTER_AUTH_URL;
  if (envUrl) {
    return envUrl.replace(TRAILING_SLASH, "");
  }
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

const DISCOVERY_COLUMNS = {
  id: workflows.id,
  name: workflows.name,
  description: workflows.description,
  listedSlug: workflows.listedSlug,
  inputSchema: workflows.inputSchema,
  priceUsdcPerCall: workflows.priceUsdcPerCall,
  workflowType: workflows.workflowType,
  category: workflows.category,
  chain: workflows.chain,
} as const;

type DiscoveryWorkflow = {
  id: string;
  name: string;
  description: string | null;
  listedSlug: string | null;
  inputSchema: Record<string, unknown> | null;
  priceUsdcPerCall: string | null;
  workflowType: "read" | "write";
  category: string | null;
  chain: string | null;
};

function buildPathEntry(workflow: DiscoveryWorkflow): Record<string, unknown> {
  const isPaid =
    workflow.workflowType === "read" &&
    Number(workflow.priceUsdcPerCall ?? "0") > 0;
  const isWrite = workflow.workflowType === "write";

  const operation: Record<string, unknown> = {
    operationId: `call-${workflow.listedSlug}`,
    summary: workflow.name,
    description: workflow.description
      ? sanitizeDescription(workflow.description)
      : undefined,
  };

  // Canonical OpenAPI 3.x auth declaration. Paid routes leave `security`
  // unset (their auth comes via x-payment-info → 402); non-paid routes
  // declare `security: []` which OpenAPI defines as "no authentication
  // required". Discovery scanners (agentcash, x402scan, CDP Bazaar) read
  // the standard fields, not custom x-auth-mode extensions.
  // Note: write workflows are never paid at the HTTP layer — they always
  // return unsigned calldata that the caller signs+broadcasts (see
  // app/api/mcp/workflows/[slug]/call/route.ts handleWriteWorkflow).
  if (!isPaid) {
    operation.security = [];
  }

  if (isWrite) {
    operation["x-workflow-type"] = "write";
  }

  if (isPaid) {
    operation["x-payment-info"] = {
      price: {
        mode: "fixed",
        amount: workflow.priceUsdcPerCall,
        currency: "USD",
      },
      protocols: [
        { x402: { network: "eip155:8453" } },
        { mpp: { method: "tempo", intent: "charge", currency: "USDC" } },
      ],
    };
  }

  // Always declare a request body for paid routes so scanners get a clean
  // input schema (validator complains: L3_INPUT_SCHEMA_MISSING). For
  // workflows whose owners haven't backfilled inputSchema in the DB, fall
  // back to an open object — better than nothing.
  if (workflow.inputSchema && "properties" in workflow.inputSchema) {
    operation.requestBody = {
      required: true,
      content: {
        "application/json": { schema: workflow.inputSchema },
      },
    };
  } else if (isPaid || isWrite) {
    // Fallback so paid+write routes always declare a body schema. Validators
    // (e.g. @agentcash/discovery) flag L3_INPUT_SCHEMA_MISSING when paid
    // routes have no requestBody at all. `type: object` already permits any
    // properties; no `additionalProperties: true` needed.
    operation.requestBody = {
      required: false,
      content: {
        "application/json": { schema: { type: "object" } },
      },
    };
  }

  const responses: Record<string, unknown> = {};

  if (isWrite) {
    responses["200"] = {
      description: "Unsigned transaction calldata",
      content: {
        "application/json": {
          schema: {
            type: "object",
            properties: {
              type: { type: "string", const: "calldata" },
              to: { type: "string" },
              data: { type: "string" },
              value: { type: "string" },
            },
          },
        },
      },
    };
  } else {
    responses["200"] = {
      description: "Workflow execution started",
      content: {
        "application/json": {
          schema: {
            type: "object",
            properties: {
              executionId: { type: "string" },
              status: { type: "string", const: "running" },
            },
          },
        },
      },
    };
  }

  if (isPaid) {
    responses["402"] = { description: "Payment Required" };
  }

  operation.responses = responses;

  return { post: operation };
}

export async function GET(request: Request): Promise<Response> {
  const baseUrl = deriveBaseUrl(request);

  const rows = await db
    .select(DISCOVERY_COLUMNS)
    .from(workflows)
    .where(and(eq(workflows.isListed, true), workflowNotDeleted()));

  const paths: Record<string, Record<string, unknown>> = {};

  for (const row of rows as DiscoveryWorkflow[]) {
    if (!row.listedSlug) {
      continue;
    }
    paths[`/api/mcp/workflows/${row.listedSlug}/call`] = buildPathEntry(row);
  }

  const doc = {
    openapi: "3.1.0",
    info: {
      title: "KeeperHub",
      version: "1.0.0",
      description:
        "Web3 workflow automation platform. Workflows are callable by AI agents via REST or MCP.",
      "x-guidance": [
        "KeeperHub exposes workflows as REST endpoints under /api/mcp/workflows/{slug}/call.",
        "Each workflow has a slug, accepts a JSON body, and returns a JSON response with `executionId`, `status`, and `output`.",
        "Auth: paid workflows return HTTP 402 with x402/MPP payment info on the first call; pay (e.g. via agentcash, openclaw, or any x402 client) and replay. Free workflows can be called directly.",
        "Categories of workflows include: DeFi yield/risk reads (e.g. usdc-yield-rates-aave-vs-compound, aave-v3-health-check, defi-risk-snapshot), tipping primitives (microtip), and write-type workflows that return unsigned calldata for the caller to sign and broadcast.",
        "",
        "## Worked examples",
        "",
        "### Example 1: Compare USDC yield (paid, $0.01)",
        "POST /api/mcp/workflows/usdc-yield-rates-aave-vs-compound/call",
        "Body: {}",
        'Response (after payment): { executionId, status: "success", output: { result: { rates: [...], bestRate, bestProtocol } } }',
        "",
        "### Example 2: Aave v3 health check (paid, $0.01)",
        "POST /api/mcp/workflows/aave-v3-health-check/call",
        'Body: { "address": "0x..." }',
        'Response (after payment): { executionId, status: "success", output: { result: { healthFactor, totalCollateralUSD, totalDebtUSD, riskLevel } } }',
        "",
        "### Example 3: Discover available workflows (free)",
        "GET /api/mcp/workflows  (returns the list of all listed workflows + pricing)",
        "GET /openapi.json       (this document; full schema for every workflow)",
        "",
        "When in doubt, fetch /openapi.json and read the per-workflow `x-payment-info`, `security`, and `requestBody` fields.",
      ].join("\n"),
    },
    "x-service-info": {
      categories: ["web3", "automation", "blockchain"],
      docs: { homepage: "https://docs.keeperhub.com" },
    },
    servers: [{ url: baseUrl }],
    components: {
      // Declared for discovery only. Paid operations deliberately leave
      // `security` unset — the HTTP 402 challenge-response conveys auth (see
      // x-payment-info). These schemes document the supported payment/identity
      // mechanisms for scanners; they are not referenced per-operation.
      securitySchemes: {
        x402: {
          type: "http",
          scheme: "Payment",
          description:
            "x402 challenge-response payment. The first unpaid call returns HTTP 402 with payment requirements; the client signs that payment and replays the request.",
        },
        siwx: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "CAIP-122",
          description:
            "Sign-In with X identity proof (CAIP-122) for compatible agent clients. KeeperHub workflow calls primarily use x402 payment discovery today.",
        },
      },
    },
    paths,
  };

  return Response.json(doc, {
    headers: {
      "Cache-Control": "public, max-age=300, stale-while-revalidate=600",
    },
  });
}
