"use client";

import { useSetAtom } from "jotai";
import { History, Pencil, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  DeleteConnectionOverlay,
  EditConnectionOverlay,
} from "@/components/overlays/edit-connection-overlay";
import { IntegrationActivityOverlay } from "@/components/overlays/integration-activity-overlay";
import { useOverlay } from "@/components/overlays/overlay-provider";
import { Button } from "@/components/ui/button";
import { IntegrationIcon } from "@/components/ui/integration-icon";
import { Spinner } from "@/components/ui/spinner";
import { api, type Integration } from "@/lib/api-client";
import { useActiveMember } from "@/lib/hooks/use-organization";
import { integrationsAtom } from "@/lib/integrations-store";
import { getIntegrationLabels } from "@/plugins/registry";

// System integrations that don't have plugins
const SYSTEM_INTEGRATION_LABELS: Record<string, string> = {
  database: "Database",
};

type IntegrationsManagerProps = {
  onIntegrationChange?: () => void;
  filter?: string;
  // When set (e.g. opened from the activity feed), the matching row is
  // highlighted and scrolled into view.
  highlightId?: string;
};

export function IntegrationsManager({
  onIntegrationChange,
  filter = "",
  highlightId,
}: IntegrationsManagerProps) {
  const { push } = useOverlay();
  const highlightedRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (highlightId && highlightedRef.current) {
      highlightedRef.current.scrollIntoView({ block: "nearest" });
    }
  }, [highlightId]);
  const { isAdmin } = useActiveMember();
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [loading, setLoading] = useState(true);
  const [_testingId, setTestingId] = useState<string | null>(null);
  const setGlobalIntegrations = useSetAtom(integrationsAtom);

  const loadIntegrations = useCallback(async () => {
    try {
      setLoading(true);
      const data = await api.integration.getAll();
      setIntegrations(data);
      setGlobalIntegrations(data);
    } catch (error) {
      console.error("Failed to load integrations:", error);
      toast.error("Failed to load integrations");
    } finally {
      setLoading(false);
    }
  }, [setGlobalIntegrations]);

  useEffect(() => {
    loadIntegrations();
  }, [loadIntegrations]);

  // Get integrations with their labels, sorted by label then name
  const integrationsWithLabels = useMemo(() => {
    const labels = getIntegrationLabels() as Record<string, string>;
    const filterLower = filter.toLowerCase();

    return (
      integrations
        // Web3 wallets are managed in their own dedicated section, not as a
        // generic connection. Keep them in the global store but hide them here.
        .filter((integration) => integration.type !== "web3")
        .map((integration) => ({
          ...integration,
          label:
            labels[integration.type] ||
            SYSTEM_INTEGRATION_LABELS[integration.type] ||
            integration.type,
        }))
        .filter((integration) => {
          if (!filter) {
            return true;
          }
          return (
            integration.label.toLowerCase().includes(filterLower) ||
            integration.name.toLowerCase().includes(filterLower) ||
            integration.type.toLowerCase().includes(filterLower)
          );
        })
        .sort((a, b) => {
          const labelCompare = a.label.localeCompare(b.label);
          if (labelCompare !== 0) {
            return labelCompare;
          }
          return a.name.localeCompare(b.name);
        })
    );
  }, [integrations, filter]);

  const handleEdit = (integration: Integration) => {
    push(EditConnectionOverlay, {
      integration,
      onSuccess: () => {
        loadIntegrations();
        onIntegrationChange?.();
      },
      onDelete: () => {
        loadIntegrations();
        onIntegrationChange?.();
      },
    });
  };

  const handleDelete = (integration: Integration) => {
    push(DeleteConnectionOverlay, {
      integration,
      onSuccess: () => {
        loadIntegrations();
        onIntegrationChange?.();
      },
    });
  };

  const _handleTest = async (id: string) => {
    try {
      setTestingId(id);
      const result = await api.integration.testConnection(id);

      if (result.status === "success") {
        toast.success(result.message || "Connection successful");
      } else {
        toast.error(result.message || "Connection test failed");
      }
    } catch (error) {
      console.error("Connection test failed:", error);
      toast.error(
        error instanceof Error ? error.message : "Connection test failed"
      );
    } finally {
      setTestingId(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Spinner />
      </div>
    );
  }

  const renderIntegrationsList = () => {
    if (integrations.length === 0) {
      return (
        <div className="py-8 text-center">
          <p className="text-muted-foreground text-sm">
            No connections configured yet
          </p>
        </div>
      );
    }

    if (integrationsWithLabels.length === 0) {
      return (
        <div className="py-8 text-center">
          <p className="text-muted-foreground text-sm">
            No connections match your filter
          </p>
        </div>
      );
    }

    return (
      <div className="space-y-1">
        {integrationsWithLabels.map((integration) => (
          <div
            className={`flex items-center justify-between rounded-md px-2 py-1.5 ${
              integration.id === highlightId
                ? "bg-muted/40 ring-2 ring-primary/60 ring-inset"
                : ""
            }`}
            key={integration.id}
            ref={integration.id === highlightId ? highlightedRef : undefined}
          >
            <div className="flex items-center gap-2">
              <IntegrationIcon
                className="size-4"
                integration={integration.type}
              />
              <span className="font-medium text-sm">{integration.label}</span>
              <span className="text-muted-foreground text-sm">
                {integration.name}
              </span>
            </div>
            <div className="flex items-center gap-1">
              {/* Test button hidden - unreliable functionality */}
              {/* <Button
                className="h-7 px-2"
                disabled={testingId === integration.id}
                onClick={() => handleTest(integration.id)}
                size="sm"
                variant="outline"
              >
                {testingId === integration.id ? (
                  <Spinner className="size-3" />
                ) : (
                  <span className="text-xs">Test</span>
                )}
              </Button> */}
              {isAdmin && (
                <Button
                  className="size-7"
                  onClick={() =>
                    push(IntegrationActivityOverlay, { integration })
                  }
                  size="icon"
                  title="View activity"
                  variant="outline"
                >
                  <History className="size-3" />
                </Button>
              )}
              <Button
                className="size-7"
                onClick={() => handleEdit(integration)}
                size="icon"
                variant="outline"
              >
                <Pencil className="size-3" />
              </Button>
              <Button
                className="size-7"
                onClick={() => handleDelete(integration)}
                size="icon"
                variant="outline"
              >
                <Trash2 className="size-3" />
              </Button>
            </div>
          </div>
        ))}
      </div>
    );
  };

  return <div className="space-y-1">{renderIntegrationsList()}</div>;
}
