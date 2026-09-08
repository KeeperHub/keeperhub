import type { WorkflowNode } from "../lib/workflow/store";
import { findActionById } from "../plugins/registry";
import { CONFIG } from "./config";
import type { DispatchTarget } from "./types";

/**
 * Determine how a workflow should be executed based on EXECUTION_MODE config.
 *
 * Modes:
 * - "isolated": Always use K8s Job container (full isolation per execution)
 * - "process": Always call the KeeperHub API endpoint (no isolation)
 * - "complex": Inspect workflow nodes at runtime — K8s Job for web3 writes,
 *              in-process for everything else
 * - "in-process": Always run steps directly in the executor process (dev/docker-compose)
 */
export function resolveDispatchTarget(nodes: WorkflowNode[]): DispatchTarget {
  switch (CONFIG.executionMode) {
    case "isolated":
      return "k8s-job";
    case "process":
      return "api";
    case "complex":
      return hasWeb3Writes(nodes) ? "k8s-job" : "in-process";
    case "in-process":
      return "in-process";
    default: {
      const _exhaustive: never = CONFIG.executionMode;
      throw new Error(`Unknown EXECUTION_MODE: ${_exhaustive}`);
    }
  }
}

/**
 * Check if any workflow node contains a web3 write action.
 * Uses requiresCredentials on plugin action definitions as the signal.
 */
function hasWeb3Writes(nodes: WorkflowNode[]): boolean {
  for (const node of nodes) {
    if (node.data.type !== "action") {
      continue;
    }

    const actionType = node.data.config?.actionType as string | undefined;
    if (!actionType) {
      continue;
    }

    const action = findActionById(actionType);
    if (action?.requiresCredentials) {
      return true;
    }
  }

  return false;
}
