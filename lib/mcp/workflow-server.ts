import "server-only";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  buildTriggerInputSchema,
  detectListingTriggerType,
  normalizeTriggerInput,
} from "@/lib/mcp/trigger-input-schema";

type ApiResponse = Record<string, unknown>;

async function callApi(
  internalApiBaseUrl: string,
  authHeader: string,
  path: string,
  method: string,
  body?: unknown
): Promise<ApiResponse> {
  const url = `${internalApiBaseUrl}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: authHeader,
  };

  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `API call failed: ${response.status} ${response.statusText} - ${errorText}`
    );
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return (await response.json()) as ApiResponse;
  }

  return { result: await response.text() };
}

export type WorkflowListing = {
  id: string;
  name: string;
  description: string | null;
  listedSlug: string | null;
  inputSchema: Record<string, unknown> | null;
  outputMapping: Record<string, unknown> | null;
  priceUsdcPerCall: string | null;
  workflowType: "read" | "write";
  listingVersion: number;
  nodes: unknown[];
};

type CreateWorkflowMcpServerOptions = {
  slug: string;
  listing: WorkflowListing;
  internalApiBaseUrl: string;
  authHeader: string;
  scope?: string;
};

function buildToolDescription(listing: WorkflowListing): string {
  const parts: string[] = [];

  parts.push(`${listing.name}.`);

  if (listing.description) {
    parts.push(listing.description);
  }

  const inputSchema = listing.inputSchema;
  if (
    inputSchema &&
    typeof inputSchema === "object" &&
    "properties" in inputSchema &&
    inputSchema.properties &&
    typeof inputSchema.properties === "object"
  ) {
    const props = inputSchema.properties as Record<string, unknown>;
    const required = Array.isArray(inputSchema.required)
      ? (inputSchema.required as string[])
      : [];
    const fieldLines: string[] = [];
    for (const [key, def] of Object.entries(props)) {
      const defObj = def as Record<string, unknown>;
      const typeStr = typeof defObj.type === "string" ? defObj.type : "any";
      const descStr =
        typeof defObj.description === "string"
          ? ` — ${defObj.description}`
          : "";
      const reqStr = required.includes(key) ? " (required)" : " (optional)";
      fieldLines.push(`  ${key}: ${typeStr}${reqStr}${descStr}`);
    }
    if (fieldLines.length > 0) {
      parts.push(`Inputs:\n${fieldLines.join("\n")}`);
    }
  }

  if (listing.outputMapping && Object.keys(listing.outputMapping).length > 0) {
    const outputKeys = Object.keys(listing.outputMapping).join(", ");
    parts.push(`Output fields: ${outputKeys}`);
  }

  const price = Number(listing.priceUsdcPerCall ?? "0");
  if (price > 0) {
    parts.push(
      `This is a paid workflow. Price: ${listing.priceUsdcPerCall} USDC per call. Pay via @keeperhub/wallet paymentSigner.fetch() or agentcash mcp__agentcash__fetch.`
    );
  }

  return parts.join(" ");
}

export function createWorkflowMcpServer(
  options: CreateWorkflowMcpServerOptions
): McpServer {
  const { slug, listing, internalApiBaseUrl, authHeader } = options;

  const server = new McpServer({
    name: `keeperhub-workflow-${slug}`,
    version: String(listing.listingVersion),
  });

  const toolDescription = buildToolDescription(listing);
  const triggerKind = detectListingTriggerType(listing.nodes);
  const inputSchema = buildTriggerInputSchema(triggerKind);

  server.registerTool(
    slug,
    {
      title: listing.name,
      description: toolDescription,
      inputSchema,
      annotations: {
        readOnlyHint: listing.workflowType === "read",
        destructiveHint: false,
      },
    },
    async (args: unknown) => {
      const normalized = normalizeTriggerInput(args);
      const data = await callApi(
        internalApiBaseUrl,
        authHeader,
        `/api/mcp/workflows/${encodeURIComponent(slug)}/call`,
        "POST",
        normalized
      );
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  return server;
}
