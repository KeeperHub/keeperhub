import type { StepInput } from "@/lib/workflow/executor/step-handler";
import {
  type OrgRpcScope,
  PlatformRpcPurpose,
  type PlatformRpcScope,
  type RpcScope,
  RpcScopeKind,
  type RpcSelection,
  RpcSelectionMode,
} from "./types";

/** The node config key that holds a step's RPC selection. */
export const RPC_SELECTION_CONFIG_KEY = "rpcConfig";

const AUTO: RpcSelection = { mode: RpcSelectionMode.AUTO };

/**
 * Read a stored selection. Missing or blank values mean auto. The stored
 * keywords are the mode names `RpcSelectionMode.AUTO` and
 * `RpcSelectionMode.PLATFORM`; any other value is a config id, which the
 * resolver checks against the organization's configs.
 */
export function parseRpcSelection(value: unknown): RpcSelection {
  if (typeof value !== "string") {
    return AUTO;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed === RpcSelectionMode.AUTO) {
    return AUTO;
  }
  if (trimmed === RpcSelectionMode.PLATFORM) {
    return { mode: RpcSelectionMode.PLATFORM };
  }
  return { mode: RpcSelectionMode.CONFIG, configId: trimmed };
}

export function platformScope(purpose: PlatformRpcPurpose): PlatformRpcScope {
  return { kind: RpcScopeKind.PLATFORM, purpose };
}

export type OrgScopeIds = {
  workflowId?: string;
  executionId?: string;
  nodeId?: string;
};

export function orgScope(
  organizationId: string,
  selection: RpcSelection = AUTO,
  ids: OrgScopeIds = {}
): OrgRpcScope {
  return { kind: RpcScopeKind.ORG, organizationId, selection, ...ids };
}

/**
 * The scope of a workflow or direct-execution step. A step that belongs to
 * no organization can only use KeeperHub endpoints.
 */
export function rpcScopeFromStep(input: StepInput): RpcScope {
  const context = input._context;
  const organizationId = context?.organizationId;
  if (!organizationId) {
    return platformScope(PlatformRpcPurpose.NO_ORGANIZATION);
  }
  const selection = parseRpcSelection(
    (input as Record<string, unknown>)[RPC_SELECTION_CONFIG_KEY]
  );
  return orgScope(organizationId, selection, {
    workflowId: context.workflowId,
    executionId: context.executionId,
    nodeId: context.nodeId,
  });
}
