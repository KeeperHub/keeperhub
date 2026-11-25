import type { StepContext } from "@/lib/workflow/executor/step-handler";
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
 * KeeperHub traffic for an organization's request, or the no-organization
 * platform scope when the request belongs to none.
 */
export function rpcScopeForOrganization(
  organizationId: string | null | undefined,
  selection: RpcSelection = AUTO,
  ids: OrgScopeIds = {}
): RpcScope {
  return organizationId
    ? orgScope(organizationId, selection, ids)
    : platformScope(PlatformRpcPurpose.NO_ORGANIZATION);
}

/** What a step input needs to carry for its scope to be read from it. */
export type RpcStepInput = {
  _context?: Partial<
    Pick<
      StepContext,
      "organizationId" | "workflowId" | "executionId" | "nodeId"
    >
  >;
};

/**
 * The scope of a workflow or direct-execution step: its organization, and the
 * node's selection from its `RPC_SELECTION_CONFIG_KEY` config value. Steps
 * that resolve their organization from the execution pass it as
 * `organizationId`.
 */
export function rpcScopeFromStep(
  input: RpcStepInput,
  organizationId?: string
): RpcScope {
  const context = input._context;
  return rpcScopeForOrganization(
    organizationId ?? context?.organizationId,
    parseRpcSelection(
      (input as Record<string, unknown>)[RPC_SELECTION_CONFIG_KEY]
    ),
    {
      workflowId: context?.workflowId,
      executionId: context?.executionId,
      nodeId: context?.nodeId,
    }
  );
}

/**
 * A pinned config names one chain. Calls spread over several networks follow
 * the organization's defaults instead; a KeeperHub selection still applies.
 */
export function scopeForManyChains(scope: RpcScope): RpcScope {
  return scope.kind === RpcScopeKind.ORG &&
    scope.selection.mode === RpcSelectionMode.CONFIG
    ? { ...scope, selection: AUTO }
    : scope;
}
