import { workflows } from "@/lib/db/schema";

/**
 * Exact columns the call route needs from the workflows table.
 * priceUsdcPerCall returns string | null from Drizzle (numeric column).
 * nodes and edges are needed for execution; userId for creating the execution record.
 * category/tagId feed the x402 Bazaar extensions for marketplace discovery.
 */
export type CallRouteWorkflow = {
  id: string;
  name: string;
  description: string | null;
  organizationId: string | null;
  listedSlug: string | null;
  inputSchema: Record<string, unknown> | null;
  outputMapping: Record<string, unknown> | null;
  priceUsdcPerCall: string | null;
  isListed: boolean;
  // Gated in-memory after the lookup so a listed-but-disabled workflow can be
  // surfaced as "temporarily unavailable" rather than 404. The lookup's SQL
  // filters the hard-gone states (deleted, deactivated owner) instead.
  enabled: boolean;
  workflowType: "read" | "write";
  nodes: unknown[];
  edges: unknown[];
  userId: string;
  category: string | null;
  tagName: string | null;
};

/**
 * Column projection for the call route DB query.
 * Mirrors the LISTED_WORKFLOW_COLUMNS pattern from app/api/mcp/workflows/route.ts
 * but includes the execution-required columns: nodes, edges, userId.
 */
export const CALL_ROUTE_COLUMNS = {
  id: workflows.id,
  name: workflows.name,
  description: workflows.description,
  organizationId: workflows.organizationId,
  listedSlug: workflows.listedSlug,
  inputSchema: workflows.inputSchema,
  outputMapping: workflows.outputMapping,
  priceUsdcPerCall: workflows.priceUsdcPerCall,
  isListed: workflows.isListed,
  enabled: workflows.enabled,
  workflowType: workflows.workflowType,
  nodes: workflows.nodes,
  edges: workflows.edges,
  // createdBy, loaded solely to populate the execution row's audit column.
  // Never an authority signal: the call route authorizes, meters, and pays
  // via organizationId (org wallet, org quota, org credential principal).
  userId: workflows.userId,
  category: workflows.category,
} as const;
