import "server-only";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { hasIrreversibleEffect } from "@/lib/mcp/action-type";
import {
  buildTriggerInputSchema,
  detectListingTriggerType,
  normalizeTriggerInput,
} from "@/lib/mcp/trigger-input-schema";
import { resolveProtocolMeta } from "@/plugins/protocol/steps/resolve-protocol-meta";
// Protocol registration is an import side effect: each definition module calls
// registerProtocol at load. Nothing else in the /mcp/w/[slug] route's graph
// pulls this barrel, so without it resolveProtocolMeta's registry lookup finds
// nothing and every protocol node falls back to its cached _protocolMeta
// alone. lib/execute/stablecoin-cap.ts carries the same import for the same
// reason, after an empty registry silently voided its allowlist.
import "@/protocols";

type NodeAction = { actionType: unknown; protocolMeta: unknown };

function getNodeAction(node: unknown): NodeAction {
  if (node === null || typeof node !== "object" || !("data" in node)) {
    return { actionType: undefined, protocolMeta: undefined };
  }
  const { data } = node as { data?: unknown };
  if (data === null || typeof data !== "object") {
    return { actionType: undefined, protocolMeta: undefined };
  }
  const config =
    "config" in data ? (data as Record<string, unknown>).config : undefined;
  const configRecord =
    config !== null && typeof config === "object"
      ? (config as Record<string, unknown>)
      : undefined;
  const legacyActionType =
    "actionType" in data
      ? (data as Record<string, unknown>).actionType
      : undefined;
  return {
    actionType: configRecord?.actionType ?? legacyActionType,
    protocolMeta: configRecord?._protocolMeta,
  };
}

/**
 * True for a protocol action node whose action writes on chain.
 *
 * Protocol action types are `<protocol>/<action-slug>` (sky/approve-usds,
 * lido/wsteth-wrap), so they match none of the literal names in
 * hasIrreversibleEffect's allowlist and none of isWriteActionType's
 * write-contract/protocol-write substrings. The sky-staking onboarding
 * listing is built from two of them and advertised readOnlyHint true while
 * executing an ERC-20 approval and a vault deposit from the org wallet.
 *
 * resolveProtocolMeta is the resolver protocolWriteStep already uses to pick
 * the contract function, so the annotation and the execution path cannot
 * disagree about what an action does. It reads the registry first, which
 * covers every registered protocol including ones added after this code, and
 * falls back to the node's cached _protocolMeta so a node whose protocol is
 * absent from this process's registry still classifies.
 */
function isProtocolWriteNode({
  actionType,
  protocolMeta,
}: NodeAction): boolean {
  const meta = resolveProtocolMeta({
    ...(typeof actionType === "string" ? { _actionType: actionType } : {}),
    ...(typeof protocolMeta === "string"
      ? { _protocolMeta: protocolMeta }
      : {}),
  });
  return meta?.actionType === "write";
}

// Broader than workflowType === "write": also catches actions that
// deriveWorkflowType never promotes to "write" because they cannot be served
// by the calldata-handoff MCP route, plus the outbound-message actions that
// have no chain effect at all. Those workflows correctly stay
// workflowType="read" for routing purposes, but they still broadcast a
// transaction or send a message the caller cannot recall, so the annotations
// need this separate, wider check rather than reusing workflowType.
function hasMutatingNode(nodes: unknown[]): boolean {
  return nodes.some((node) => {
    const action = getNodeAction(node);
    return (
      hasIrreversibleEffect(action.actionType) || isProtocolWriteNode(action)
    );
  });
}

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
  const isReadOnlyListing =
    listing.workflowType === "read" && !hasMutatingNode(listing.nodes);

  server.registerTool(
    slug,
    {
      title: listing.name,
      description: toolDescription,
      inputSchema,
      // listing.workflowType alone does not describe side effects: the call
      // route runs a "read" listing server-side with the owner's wallet and
      // credentials (handleReadWorkflow -> startExecutionInBackground) while
      // a "write" listing only returns unsigned calldata for the caller to
      // sign, so "read" is the branch that actually executes. hasMutatingNode
      // is the wider check that catches the mutating nodes deriveWorkflowType
      // leaves typed "read".
      //
      // destructiveHint tracks readOnlyHint rather than being pinned false.
      // Under the MCP spec destructiveHint defaults to true and is only
      // meaningful when readOnlyHint is false, so an explicit false on a
      // non-read listing is a positive assertion that a call is safe to run
      // unattended -- which nothing here establishes. A listing that is not
      // provably read-only is therefore advertised as destructive.
      annotations: {
        readOnlyHint: isReadOnlyListing,
        destructiveHint: !isReadOnlyListing,
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
