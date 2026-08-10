import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { type Chain, chains, workflows } from "@/lib/db/schema";
import { authenticateInternalService } from "@/lib/internal-service-auth";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { getProtocol } from "@/lib/protocol-registry";
import type { WorkflowNode } from "@/lib/workflow/store";
import { WorkflowTriggerEnum } from "@/lib/workflow/store";
import { workflowNotDeleted } from "@/lib/workflow/soft-delete";

// The Transfer trigger always watches the fixed TIP-20
// TransferWithMemo event. The event-tracker's mapper needs an ABI + event name
// on the trigger config to build a subscription, so we inject them here rather
// than surfacing ABI/event pickers to the user.
const TEMPO_TRANSFER_WITH_MEMO_EVENT = "TransferWithMemo";
const TEMPO_TRANSFER_WITH_MEMO_ABI = JSON.stringify([
  {
    type: "event",
    name: "TransferWithMemo",
    anonymous: false,
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
      { name: "memo", type: "bytes32", indexed: true },
    ],
  },
]);

/** The chainId a trigger node targets (config.network), or null if absent/unparseable. */
function triggerChainId(node: WorkflowNode | undefined): number | null {
  const raw = node?.data?.config?.network;
  if (typeof raw !== "string" && typeof raw !== "number") {
    return null;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Internal endpoint for workers to fetch active Event-type workflows.
 * Returns only enabled workflows with Event trigger type. Authentication
 * goes through the shared authenticateInternalService helper, which verifies
 * the request's HMAC signature.
 */
export async function GET(request: Request) {
  try {
    const auth = await authenticateInternalService(request);
    if (!auth.authenticated) {
      return NextResponse.json(
        { error: auth.error ?? "Unauthorized" },
        { status: auth.status }
      );
    }

    const { searchParams } = new URL(request.url);
    const activeParam = searchParams.get("active");

    const filterActive = activeParam === "true";

    // Additive chainType filter. Default "evm" preserves prior behavior (all
    // existing event workflows are EVM); "solana" scopes the response to
    // Solana-network workflows for the solana-tracker service.
    const requestedChainType =
      searchParams.get("chainType") === "solana" ? "solana" : "evm";

    const query = db
      .select({
        id: workflows.id,
        name: workflows.name,
        userId: workflows.userId,
        organizationId: workflows.organizationId,
        enabled: workflows.enabled,
        nodes: workflows.nodes,
      })
      .from(workflows);

    // KEEP-440: never hand a soft-deleted workflow to the events worker.
    const allWorkflows = filterActive
      ? await query.where(
          and(eq(workflows.enabled, true), workflowNotDeleted())
        )
      : await query.where(workflowNotDeleted());

    const eventWorkflows = allWorkflows
      .map((workflow) => {
        try {
          const nodes = workflow.nodes as WorkflowNode[];
          if (!Array.isArray(nodes)) {
            return null;
          }

          const triggerNode = nodes.find(
            (node) => node.data?.type === "trigger"
          );

          if (!triggerNode) {
            return null;
          }

          // Admit Event triggers and the Transfer trigger; both
          // register through the event-tracker as on-chain log subscriptions.
          const triggerType = triggerNode.data?.config?.triggerType as
            | string
            | undefined;

          const isEventTrigger = triggerType === WorkflowTriggerEnum.EVENT;
          const isTempoPaymentTrigger =
            triggerType === WorkflowTriggerEnum.TEMPO_PAYMENT;
          if (!(isEventTrigger || isTempoPaymentTrigger)) {
            return null;
          }

          const config = triggerNode.data?.config;

          // Inject the fixed TransferWithMemo ABI + event name for the Tempo
          // trigger so the mapper can build the subscription. contractAddress
          // (the token) and network come from the user's config.
          if (isTempoPaymentTrigger && config) {
            config.contractABI = TEMPO_TRANSFER_WITH_MEMO_ABI;
            config.eventName = TEMPO_TRANSFER_WITH_MEMO_EVENT;
          }

          // Try to infer contract address from protocol and event slug
          if (isEventTrigger && config && !config.contractAddress) {
            const protocolSlug = config._eventProtocolSlug as
              | string
              | undefined;
            const eventSlug = config._eventSlug as string | undefined;
            const network = config.network as string | undefined;

            if (protocolSlug && eventSlug && network) {
              const protocol = getProtocol(protocolSlug);
              const event = protocol?.events?.find(
                (e) => e.slug === eventSlug
              );
              if (protocol && event) {
                const contract = protocol.contracts[event.contract];
                const address = contract?.addresses[network];
                if (address) {
                  config.contractAddress = address;
                }
              }
            }
          }

          return {
            id: workflow.id,
            name: workflow.name,
            userId: workflow.userId,
            organizationId: workflow.organizationId,
            enabled: workflow.enabled,
            nodes: [triggerNode],
          };
        } catch {
          // If parsing fails, exclude this workflow
          return null;
        }
      })
      .filter((workflow) => workflow !== null);

    const networks = await db
      .select({
        id: chains.id,
        chainId: chains.chainId,
        name: chains.name,
        symbol: chains.symbol,
        aliases: chains.aliases,
        isPaymentRail: chains.isPaymentRail,
        chainType: chains.chainType,
        defaultPrimaryRpc: chains.defaultPrimaryRpc,
        defaultFallbackRpc: chains.defaultFallbackRpc,
        defaultPrimaryWss: chains.defaultPrimaryWss,
        defaultFallbackWss: chains.defaultFallbackWss,
        usePrivateMempoolRpc: chains.usePrivateMempoolRpc,
        defaultPrivateRpcUrl: chains.defaultPrivateRpcUrl,
        isTestnet: chains.isTestnet,
        isEnabled: chains.isEnabled,
        status: chains.status,
        createdAt: chains.createdAt,
        updatedAt: chains.updatedAt,
        gasConfig: chains.gasConfig,
      })
      .from(chains);

    // Return a dictionary of chains by chainId to make it easier to lookup
    const networkMap: Record<number, Chain> = {};

    for (const network of networks) {
      networkMap[network.chainId] = network;
    }

    // Asymmetric chainType filter: "evm" is the default bucket (keep unless the
    // network resolves to a Solana chain), "solana" keeps only Solana-network
    // workflows. Workflows with a missing/unresolvable network stay in "evm".
    const solanaChainIds = new Set<number>(
      networks
        .filter((network) => network.chainType === "solana")
        .map((network) => network.chainId)
    );
    const filteredWorkflows = eventWorkflows.filter((workflow) => {
      const chainId = triggerChainId(workflow.nodes[0]);
      const isSolana = chainId !== null && solanaChainIds.has(chainId);
      return requestedChainType === "solana" ? isSolana : !isSolana;
    });

    const response = {
      workflows: filteredWorkflows,
      networks: networkMap,
    };

    return NextResponse.json(response);
  } catch (error) {
    logSystemError(ErrorCategory.DATABASE, "Failed to get event workflows", error, { endpoint: "/api/workflows/events", operation: "get" });
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to get event workflows",
      },
      { status: 500 }
    );
  }
}

