import { and, eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { type Chain, chains, workflows } from "@/lib/db/schema";
import { authenticateInternalService } from "@/lib/internal-service-auth";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { workflowNotDeleted } from "@/lib/workflow/soft-delete";
import type { WorkflowNode } from "@/lib/workflow/store";

/** The chainId a trigger node targets (config.network), or null if absent/unparseable. */
function triggerChainId(node: WorkflowNode | undefined): number | null {
  const raw = node?.data?.config?.network;
  if (typeof raw !== "string" && typeof raw !== "number") {
    return null;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export async function GET(request: Request): Promise<NextResponse> {
  const auth = await authenticateInternalService(request);
  if (!auth.authenticated) {
    return NextResponse.json(
      { error: auth.error ?? "Unauthorized" },
      { status: auth.status }
    );
  }

  try {
    const { searchParams } = new URL(request.url);
    const filterActive = searchParams.get("active") === "true";

    // Additive chainType filter. Default "evm" preserves prior behavior;
    // "solana" scopes the response for the solana-tracker service.
    const requestedChainType =
      searchParams.get("chainType") === "solana" ? "solana" : "evm";

    const blockTriggerFilter = sql`${workflows.nodes} @> '[{"data":{"type":"trigger","config":{"triggerType":"Block"}}}]'::jsonb`;

    // KEEP-440: never hand a soft-deleted workflow to the block watcher.
    const conditions = filterActive
      ? and(
          eq(workflows.enabled, true),
          blockTriggerFilter,
          workflowNotDeleted()
        )
      : and(blockTriggerFilter, workflowNotDeleted());

    const matchedWorkflows = await db
      .select({
        id: workflows.id,
        name: workflows.name,
        userId: workflows.userId,
        organizationId: workflows.organizationId,
        enabled: workflows.enabled,
        nodes: workflows.nodes,
      })
      .from(workflows)
      .where(conditions);

    const blockWorkflows = matchedWorkflows.map((workflow) => {
      const nodes = workflow.nodes as WorkflowNode[];
      const triggerNode = nodes.find((node) => node.data?.type === "trigger");
      return {
        id: workflow.id,
        name: workflow.name,
        userId: workflow.userId,
        organizationId: workflow.organizationId,
        enabled: workflow.enabled,
        nodes: triggerNode ? [triggerNode] : [],
      };
    });

    const allChains = await db
      .select()
      .from(chains)
      .where(eq(chains.isEnabled, true));

    const networkMap: Record<number, Chain> = {};
    for (const network of allChains) {
      networkMap[network.chainId] = network;
    }

    // Asymmetric chainType filter: "evm" is the default bucket (keep unless the
    // network resolves to a Solana chain), "solana" keeps only Solana-network
    // workflows. Missing/unresolvable networks stay in "evm".
    const solanaChainIds = new Set<number>(
      allChains
        .filter((network) => network.chainType === "solana")
        .map((network) => network.chainId)
    );
    const filteredWorkflows = blockWorkflows.filter((workflow) => {
      const chainId = triggerChainId(workflow.nodes[0]);
      const isSolana = chainId !== null && solanaChainIds.has(chainId);
      return requestedChainType === "solana" ? isSolana : !isSolana;
    });

    return NextResponse.json({
      workflows: filteredWorkflows,
      networks: networkMap,
    });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "Failed to get block trigger workflows",
      error,
      { endpoint: "/api/internal/block-workflows", operation: "get" }
    );
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to get block trigger workflows",
      },
      { status: 500 }
    );
  }
}
