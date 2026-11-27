"use client";

import { useState } from "react";
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
    // Rethrown so a failure is never cached as "no configs and no policy".
    console.error("[RPC Config] Failed to load organization RPC setup", error);
    throw error;
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

/**
 * The active organization's RPC configs and policy, as the editor uses them.
 * `failed` is set when they could not be read, so nothing treats the empty
 * state as the organization's real setup.
 */
export function useOrgRpcState(): {
  state: OrgRpcEditorState;
  loading: boolean;
  failed: boolean;
} {
  const organizationId = authClient.useActiveOrganization().data?.id ?? null;
  const [failed, setFailed] = useState(false);
  const { data, loading } = useCachedResource<OrgRpcEditorState>(
    organizationId ? `org-rpc-editor:${organizationId}` : null,
    async () => {
      if (!organizationId) {
        return EMPTY_STATE;
      }
      try {
        const next = await sharedLoad(organizationId);
        setFailed(false);
        return next;
      } catch (error) {
        setFailed(true);
        throw error;
      }
    }
  );
  return { state: data ?? EMPTY_STATE, loading: loading && !failed, failed };
}
