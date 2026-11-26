/**
 * Block Workflows API Client
 *
 * Fetches active block-trigger workflows from KeeperHub API and groups
 * them for monitoring: by chain ID for KeeperHub's endpoints, and by route
 * key for workflows whose organization brings its own.
 */

import { apiRequest } from "../lib/http-client.js";
import { isAddressList } from "../lib/pinned-lookup.js";
import { RpcOrigin, RpcTransport } from "../lib/rpc-route.js";
import type {
  BlockWorkflow,
  ChainConfig,
  FetchBlockWorkflowsResponse,
  RpcRoute,
} from "../lib/types.js";

export type GroupedWorkflows = Map<
  number,
  { chain: ChainConfig; workflows: BlockWorkflow[] }
>;

export type RouteGroup = {
  route: RpcRoute;
  chain: ChainConfig;
  workflows: BlockWorkflow[];
};

export type BlockWorkflowGroups = {
  platform: GroupedWorkflows;
  routed: Map<string, RouteGroup>;
};

type ResponseWorkflow = FetchBlockWorkflowsResponse["workflows"][number];

function toBlockWorkflow(workflow: ResponseWorkflow): BlockWorkflow {
  const config = workflow.nodes[0]?.data?.config;
  return {
    id: workflow.id,
    name: workflow.name,
    userId: workflow.userId,
    organizationId: workflow.organizationId,
    network: config?.network ?? String(workflow.rpcRoute?.chainId ?? ""),
    blockInterval: Number(config?.blockInterval) || 1,
  };
}

// Organization routes are never logged: their urls carry credentials.
function addRouted(
  routed: Map<string, RouteGroup>,
  workflow: ResponseWorkflow,
  route: RpcRoute,
  networks: FetchBlockWorkflowsResponse["networks"],
): void {
  if (route.transport !== RpcTransport.WSS || !hasVettedAddresses(route)) {
    return;
  }
  const blockWorkflow = toBlockWorkflow(workflow);
  const existing = routed.get(route.key);
  if (existing) {
    existing.workflows.push(blockWorkflow);
    return;
  }
  routed.set(route.key, {
    route,
    chain: {
      chainId: route.chainId,
      name: networks[route.chainId]?.name ?? `chain-${route.chainId}`,
      defaultPrimaryWss: route.primary.url,
      defaultFallbackWss: route.fallback?.url ?? null,
    },
    workflows: [blockWorkflow],
  });
}

// An organization's endpoint without vetted addresses is never dialled.
function hasVettedAddresses(route: RpcRoute): boolean {
  const endpoints = route.fallback
    ? [route.primary, route.fallback]
    : [route.primary];
  return endpoints.every(
    (endpoint) =>
      endpoint.origin !== RpcOrigin.ORG || isAddressList(endpoint.addresses),
  );
}

export async function fetchBlockWorkflows(): Promise<BlockWorkflowGroups> {
  const data = await apiRequest<FetchBlockWorkflowsResponse>(
    "/api/internal/block-workflows?active=true",
  );
  return groupBlockWorkflows(data);
}

export function groupBlockWorkflows(
  data: FetchBlockWorkflowsResponse,
): BlockWorkflowGroups {
  console.log(
    `[APIClient] Fetched ${data.workflows.length} workflow(s), ${Object.keys(data.networks).length} network(s) available: ${
      Object.entries(data.networks)
        .map(([id, n]) => `${n.name}(${id})`)
        .join(", ") || "none"
    }`,
  );

  const grouped: GroupedWorkflows = new Map();
  const routed = new Map<string, RouteGroup>();

  for (const workflow of data.workflows) {
    if (workflow.rpcRoute) {
      addRouted(routed, workflow, workflow.rpcRoute, data.networks);
      continue;
    }

    const triggerNode = workflow.nodes[0];
    const network = triggerNode?.data?.config?.network;
    const blockIntervalStr = triggerNode?.data?.config?.blockInterval;

    if (!network) {
      console.warn(
        `[APIClient] Workflow ${workflow.id} (${workflow.name}): SKIPPED — no network configured in trigger node`,
      );
      continue;
    }

    const chainId = Number(network);
    const blockInterval = Number(blockIntervalStr) || 1;
    const chainData = data.networks[chainId];

    if (!chainData) {
      console.warn(
        `[APIClient] Workflow ${workflow.id} (${workflow.name}): SKIPPED — network ${chainId} not found in available networks`,
      );
      continue;
    }

    console.log(
      `[APIClient] Workflow ${workflow.id} (${workflow.name}): chainId=${chainId} (${chainData.name}), blockInterval=${blockInterval}, primaryWss=${chainData.defaultPrimaryWss ? "yes" : "NO"}, fallbackWss=${chainData.defaultFallbackWss ? "yes" : "NO"}`,
    );

    const blockWorkflow = toBlockWorkflow(workflow);

    const existing = grouped.get(chainId);
    if (existing) {
      existing.workflows.push(blockWorkflow);
    } else {
      grouped.set(chainId, {
        chain: {
          chainId: chainData.chainId,
          name: chainData.name,
          defaultPrimaryWss: chainData.defaultPrimaryWss,
          defaultFallbackWss: chainData.defaultFallbackWss,
        },
        workflows: [blockWorkflow],
      });
    }
  }

  return { platform: grouped, routed };
}
