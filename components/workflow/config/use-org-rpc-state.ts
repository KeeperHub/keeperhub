"use client";

import { authClient } from "@/lib/auth-client";
import { useCachedResource } from "@/lib/hooks/use-cached-resource";
import { orgRpcApi } from "@/lib/rpc/org-rpc-client";
import type { OrgRpcEditorState } from "@/lib/workflow/editor/rpc-config-options";

const EMPTY_STATE: OrgRpcEditorState = { configs: [], ownRpcOnlyChains: [] };

// One request per organization at a time, shared by every field on screen.
const inFlight = new Map<string, Promise<OrgRpcEditorState>>();

async function loadState(organizationId: string): Promise<OrgRpcEditorState> {
  try {
    const [configs, policy] = await Promise.all([
      orgRpcApi.listConfigs(organizationId),
      orgRpcApi.getPolicy(organizationId),
    ]);
    return {
      configs,
      ownRpcOnlyChains: policy.chains
        .filter((chain) => chain.ownRpcOnly)
        .map((chain) => chain.chainId),
    };
  } catch (error) {
    console.error("[RPC Config] Failed to load organization RPC setup", error);
    return EMPTY_STATE;
  }
}

function sharedLoad(organizationId: string): Promise<OrgRpcEditorState> {
  const pending = inFlight.get(organizationId);
  if (pending) {
    return pending;
  }
  const next = loadState(organizationId).finally(() => {
    inFlight.delete(organizationId);
  });
  inFlight.set(organizationId, next);
  return next;
}

/** The active organization's RPC configs and policy, as the editor uses them. */
export function useOrgRpcState(): {
  state: OrgRpcEditorState;
  loading: boolean;
} {
  const organizationId = authClient.useActiveOrganization().data?.id ?? null;
  const { data, loading } = useCachedResource<OrgRpcEditorState>(
    organizationId ? `org-rpc-editor:${organizationId}` : null,
    () =>
      organizationId
        ? sharedLoad(organizationId)
        : Promise.resolve(EMPTY_STATE)
  );
  return { state: data ?? EMPTY_STATE, loading };
}
