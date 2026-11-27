"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  OrgRpcConfigView,
  OrgRpcPolicyView,
} from "@/lib/rpc/engine/org/service";
import {
  type CreateRpcConfigBody,
  orgRpcApi,
  type RpcChainOption,
  type UpdateRpcConfigBody,
} from "@/lib/rpc/org-rpc-client";
import { useSettingsContext } from "../settings-context";
import { cacheRead, cacheWrite } from "./settings-cache";

export type RpcEndpointsData = {
  configs: OrgRpcConfigView[];
  policy: OrgRpcPolicyView;
  chains: RpcChainOption[];
};

export type RpcEndpointsState = {
  data: RpcEndpointsData | undefined;
  loading: boolean;
  failed: boolean;
  refetch: () => Promise<void>;
  /** Each write throws the route's refusal as an OrgRpcApiError. */
  create: (body: CreateRpcConfigBody) => Promise<OrgRpcConfigView>;
  update: (
    configId: string,
    body: UpdateRpcConfigBody
  ) => Promise<OrgRpcConfigView>;
  remove: (configId: string) => Promise<void>;
  test: (configId: string) => Promise<boolean>;
  setOwnRpcOnly: (chainId: number, ownRpcOnly: boolean) => Promise<void>;
};

async function loadAll(organizationId: string): Promise<RpcEndpointsData> {
  const [configs, policy, chains] = await Promise.all([
    orgRpcApi.listConfigs(organizationId),
    orgRpcApi.getPolicy(organizationId),
    orgRpcApi.listChains(),
  ]);
  return { configs, policy, chains };
}

function replaceConfig(
  data: RpcEndpointsData,
  config: OrgRpcConfigView
): RpcEndpointsData {
  return {
    ...data,
    configs: data.configs.map((existing) =>
      existing.id === config.id ? config : existing
    ),
  };
}

export function useRpcEndpoints(): RpcEndpointsState {
  const { organizationId, revision } = useSettingsContext();
  const key = organizationId ? `rpc-endpoints:${organizationId}` : null;
  const [data, setData] = useState<RpcEndpointsData | undefined>(() =>
    cacheRead<RpcEndpointsData>(key)
  );
  const [failed, setFailed] = useState(false);

  const refetch = useCallback(async (): Promise<void> => {
    if (!organizationId) {
      return;
    }
    try {
      const next = await loadAll(organizationId);
      cacheWrite(key, next);
      setData(next);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [organizationId, key]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is a reload trigger, not a value this reads
  useEffect(() => {
    setData(cacheRead<RpcEndpointsData>(key));
    refetch().catch(() => undefined);
  }, [key, refetch, revision]);

  const requireOrg = useCallback((): string => {
    if (!organizationId) {
      throw new Error("No organization selected");
    }
    return organizationId;
  }, [organizationId]);

  const create = useCallback(
    async (body: CreateRpcConfigBody): Promise<OrgRpcConfigView> => {
      const config = await orgRpcApi.createConfig(requireOrg(), body);
      await refetch();
      return config;
    },
    [requireOrg, refetch]
  );

  const update = useCallback(
    async (
      configId: string,
      body: UpdateRpcConfigBody
    ): Promise<OrgRpcConfigView> => {
      const config = await orgRpcApi.updateConfig(requireOrg(), configId, body);
      // Making one config the default clears the others, and gaps move with
      // every change, so read the whole state back.
      await refetch();
      return config;
    },
    [requireOrg, refetch]
  );

  const remove = useCallback(
    async (configId: string): Promise<void> => {
      await orgRpcApi.deleteConfig(requireOrg(), configId);
      await refetch();
    },
    [requireOrg, refetch]
  );

  const test = useCallback(
    async (configId: string): Promise<boolean> => {
      const result = await orgRpcApi.testConfig(requireOrg(), configId);
      setData((current) => {
        if (!current) {
          return current;
        }
        const next = replaceConfig(current, result.config);
        cacheWrite(key, next);
        return next;
      });
      return result.allOk;
    },
    [requireOrg, key]
  );

  const setOwnRpcOnly = useCallback(
    async (chainId: number, ownRpcOnly: boolean): Promise<void> => {
      try {
        await orgRpcApi.setChainPolicy(requireOrg(), chainId, ownRpcOnly);
      } finally {
        // A refusal carries fresh gaps too, so the card shows what it says.
        await refetch();
      }
    },
    [requireOrg, refetch]
  );

  return {
    data,
    loading: data === undefined && !failed,
    failed,
    refetch,
    create,
    update,
    remove,
    test,
    setOwnRpcOnly,
  };
}
