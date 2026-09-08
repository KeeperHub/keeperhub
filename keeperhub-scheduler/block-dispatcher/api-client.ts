/**
 * Block Workflows API Client
 *
 * Fetches active block-trigger workflows from KeeperHub API
 * and groups them by chain ID for monitoring.
 */

import { apiRequest } from "../lib/http-client.js";
import type {
  BlockWorkflow,
  ChainConfig,
  FetchBlockWorkflowsResponse,
} from "../lib/types.js";

type GroupedWorkflows = Map<
  number,
  { chain: ChainConfig; workflows: BlockWorkflow[] }
>;

export async function fetchBlockWorkflows(): Promise<GroupedWorkflows> {
  const data = await apiRequest<FetchBlockWorkflowsResponse>(
    "/api/internal/block-workflows?active=true",
  );

  console.log(
    `[APIClient] Fetched ${data.workflows.length} workflow(s), ${Object.keys(data.networks).length} network(s) available: ${
      Object.entries(data.networks)
        .map(([id, n]) => `${n.name}(${id})`)
        .join(", ") || "none"
    }`,
  );

  const grouped: GroupedWorkflows = new Map();

  for (const workflow of data.workflows) {
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

    const blockWorkflow: BlockWorkflow = {
      id: workflow.id,
      name: workflow.name,
      userId: workflow.userId,
      organizationId: workflow.organizationId,
      network,
      blockInterval,
    };

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

  return grouped;
}
