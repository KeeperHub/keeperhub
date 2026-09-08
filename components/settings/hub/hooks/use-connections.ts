"use client";

import { useSetAtom } from "jotai";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { api, type Integration } from "@/lib/api-client";
import { integrationsAtom } from "@/lib/integrations-store";
import { getIntegrationLabels } from "@/plugins/registry";
import { useSettingsContext } from "../settings-context";
import { cacheRead, cacheWrite } from "./settings-cache";

const SYSTEM_INTEGRATION_LABELS: Record<string, string> = {
  database: "Database",
};

export type LabelledIntegration = Integration & { label: string };

export type ConnectionsState = {
  connections: LabelledIntegration[];
  loading: boolean;
  refetch: () => Promise<void>;
  remove: (integration: Integration) => Promise<void>;
};

/**
 * Connection list for the settings hub. Web3 wallets live in their own
 * section, so they stay in the global store but out of this list.
 */
export function useConnections(filter: string): ConnectionsState {
  const { revision, organizationId } = useSettingsContext();
  const key = organizationId ? `connections:${organizationId}` : null;
  const setGlobalIntegrations = useSetAtom(integrationsAtom);
  const [integrations, setIntegrations] = useState<Integration[]>(
    () => cacheRead<Integration[]>(key) ?? []
  );
  const [loading, setLoading] = useState(() => cacheRead(key) === undefined);

  const refetch = useCallback(async (): Promise<void> => {
    try {
      const data = await api.integration.getAll();
      setIntegrations(data);
      setGlobalIntegrations(data);
      cacheWrite(key, data);
    } catch {
      toast.error("Failed to load connections");
    } finally {
      setLoading(false);
    }
  }, [setGlobalIntegrations, key]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is a reload trigger, not a value this reads
  useEffect(() => {
    refetch().catch(() => undefined);
  }, [refetch, revision]);

  const remove = useCallback(
    async (integration: Integration): Promise<void> => {
      try {
        await api.integration.delete(integration.id);
        toast.success(`Removed ${integration.name}`);
        await refetch();
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Failed to remove connection"
        );
      }
    },
    [refetch]
  );

  const connections = useMemo(() => {
    const labels = getIntegrationLabels() as Record<string, string>;
    const needle = filter.trim().toLowerCase();

    return integrations
      .filter((integration) => integration.type !== "web3")
      .map((integration) => ({
        ...integration,
        label:
          labels[integration.type] ||
          SYSTEM_INTEGRATION_LABELS[integration.type] ||
          integration.type,
      }))
      .filter((integration) => {
        if (!needle) {
          return true;
        }
        return (
          integration.label.toLowerCase().includes(needle) ||
          integration.name.toLowerCase().includes(needle) ||
          integration.type.toLowerCase().includes(needle)
        );
      })
      .sort(
        (a, b) => a.label.localeCompare(b.label) || a.name.localeCompare(b.name)
      );
  }, [integrations, filter]);

  return { connections, loading, refetch, remove };
}
