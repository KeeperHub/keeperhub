"use client";

import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  AlertTriangle,
  Check,
  Circle,
  Pencil,
  Plus,
  Settings,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfigureConnectionOverlay } from "@/components/overlays/add-connection-overlay";
import { EditConnectionOverlay } from "@/components/overlays/edit-connection-overlay";
import { useOverlay } from "@/components/overlays/overlay-provider";
import { Button } from "@/components/ui/button";
import { api, type Integration } from "@/lib/api-client";
import {
  integrationsAtom,
  integrationsVersionAtom,
} from "@/lib/integrations-store";
import type { IntegrationType } from "@/lib/types/integration";
import { cn } from "@/lib/utils";
import { getIntegration } from "@/plugins/registry";

const SYSTEM_INTEGRATION_LABELS: Partial<Record<IntegrationType, string>> = {
  database: "Database",
};

type IntegrationSelectorProps = {
  integrationType: IntegrationType;
  value?: string;
  onChange: (integrationId: string) => void;
  onOpenSettings?: () => void;
  disabled?: boolean;
  onAddConnection?: () => void;
};

export function IntegrationSelector({
  integrationType,
  value,
  onChange,
  onOpenSettings,
  disabled,
  onAddConnection,
}: IntegrationSelectorProps) {
  const { push } = useOverlay();
  const [globalIntegrations, setGlobalIntegrations] = useAtom(integrationsAtom);
  const integrationsVersion = useAtomValue(integrationsVersionAtom);
  const setIntegrationsVersion = useSetAtom(integrationsVersionAtom);
  const lastVersionRef = useRef(integrationsVersion);
  const [hasFetched, setHasFetched] = useState(false);

  const integrations = useMemo(
    () => globalIntegrations.filter((i) => i.type === integrationType),
    [globalIntegrations, integrationType]
  );

  const hasCachedData = globalIntegrations.length > 0;

  const loadIntegrations = useCallback(async () => {
    try {
      const all = await api.integration.getAll();
      setGlobalIntegrations(all);
      setHasFetched(true);
    } catch (error) {
      console.error("Failed to load integrations:", error);
    }
  }, [setGlobalIntegrations]);

  useEffect(() => {
    loadIntegrations();
  }, [loadIntegrations, integrationType]);

  useEffect(() => {
    if (integrationsVersion !== lastVersionRef.current) {
      lastVersionRef.current = integrationsVersion;
      loadIntegrations();
    }
  }, [integrationsVersion, loadIntegrations]);

  // Auto-select a connection ONLY for a node that has none yet. Never change a
  // binding that is already set: a previously pinned connection that is missing
  // from the freshly-loaded list (deleted, or not in the active org) must not be
  // silently rebound to a different one, since that change autosaves and can
  // repoint a running workflow at the wrong database.
  useEffect(() => {
    if (integrations.length > 0 && !disabled && !value) {
      onChange(integrations[0].id);
    }
  }, [integrations, value, disabled, onChange]);

  const selectedMissing =
    Boolean(value) &&
    integrations.length > 0 &&
    !integrations.some((i) => i.id === value);

  const handleNewIntegrationCreated = useCallback(
    async (integrationId: string) => {
      await loadIntegrations();
      onChange(integrationId);
      setIntegrationsVersion((v) => v + 1);
    },
    [loadIntegrations, onChange, setIntegrationsVersion]
  );

  const handleIntegrationChange = useCallback(async () => {
    await loadIntegrations();
    setIntegrationsVersion((v) => v + 1);
  }, [loadIntegrations, setIntegrationsVersion]);

  const openNewConnectionOverlay = useCallback(() => {
    push(ConfigureConnectionOverlay, {
      type: integrationType,
      onSuccess: handleNewIntegrationCreated,
    });
  }, [integrationType, push, handleNewIntegrationCreated]);

  const openEditConnectionOverlay = useCallback(
    (integration: Integration) => {
      push(EditConnectionOverlay, {
        integration,
        onSuccess: handleIntegrationChange,
        onDelete: handleIntegrationChange,
      });
    },
    [push, handleIntegrationChange]
  );

  const handleAddConnection = useCallback(() => {
    if (onAddConnection) {
      onAddConnection();
    } else {
      openNewConnectionOverlay();
    }
  }, [onAddConnection, openNewConnectionOverlay]);

  if (!hasCachedData && !hasFetched) {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2 rounded-md px-2 py-1.5">
          <div className="size-4 shrink-0 animate-pulse rounded-full bg-muted" />
          <div className="h-4 flex-1 animate-pulse rounded bg-muted" />
          <div className="size-6 shrink-0 animate-pulse rounded bg-muted" />
        </div>
      </div>
    );
  }

  const plugin = getIntegration(integrationType);
  const integrationLabel =
    plugin?.label ||
    SYSTEM_INTEGRATION_LABELS[integrationType] ||
    integrationType;

  const missingSelectionWarning = selectedMissing ? (
    <div className="flex items-center gap-2 rounded-md border border-orange-500/50 bg-orange-500/10 px-3 py-1.5 text-orange-600 text-sm dark:text-orange-400">
      <AlertTriangle className="size-4 shrink-0" />
      <span className="flex-1 text-left">
        Selected {integrationLabel} connection is unavailable - choose one below
      </span>
    </div>
  ) : null;

  if (integrations.length === 0) {
    return (
      <Button
        className="w-full justify-start gap-2 border-orange-500/50 bg-orange-500/10 text-orange-600 hover:bg-orange-500/20 dark:text-orange-400"
        disabled={disabled}
        onClick={handleAddConnection}
        variant="outline"
      >
        <AlertTriangle className="size-4" />
        <span className="flex-1 text-left">
          Add {integrationLabel} connection
        </span>
        <Plus className="size-4" />
      </Button>
    );
  }

  if (integrations.length === 1) {
    const integration = integrations[0];
    const displayName = integration.name || `${integrationLabel} API Key`;
    const isSelected = value === integration.id;

    return (
      <div className="flex flex-col gap-1">
        {missingSelectionWarning}
        <div
          className={cn(
            "flex h-9 w-full items-center gap-2 rounded-md border px-3 text-sm",
            disabled && "cursor-not-allowed opacity-50"
          )}
        >
          <button
            className="flex flex-1 items-center gap-2 truncate text-left"
            disabled={disabled}
            onClick={() => onChange(integration.id)}
            type="button"
          >
            {isSelected ? (
              <Check className="size-4 shrink-0 text-green-600" />
            ) : (
              <Circle className="size-4 shrink-0 text-muted-foreground" />
            )}
            <span className="flex-1 truncate">{displayName}</span>
          </button>
          <Button
            className="size-6 shrink-0"
            disabled={disabled}
            onClick={() => openEditConnectionOverlay(integration)}
            size="icon"
            variant="ghost"
          >
            <Pencil className="size-3" />
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      {missingSelectionWarning}
      {integrations.map((integration) => {
        const isSelected = value === integration.id;
        const displayName = integration.name || `${integrationLabel} API Key`;
        return (
          <div
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-[13px] py-1.5 text-sm transition-colors",
              isSelected ? "bg-primary/10 text-primary" : "hover:bg-muted/50",
              disabled && "cursor-not-allowed opacity-50"
            )}
            key={integration.id}
          >
            <button
              className="flex flex-1 items-center gap-2 text-left"
              disabled={disabled}
              onClick={() => onChange(integration.id)}
              type="button"
            >
              {isSelected ? (
                <Check className="size-4 shrink-0" />
              ) : (
                <Circle className="size-4 shrink-0 text-muted-foreground" />
              )}
              <span className="truncate">{displayName}</span>
            </button>
            <Button
              className="size-6 shrink-0"
              disabled={disabled}
              onClick={(e) => {
                e.stopPropagation();
                openEditConnectionOverlay(integration);
              }}
              size="icon"
              variant="ghost"
            >
              <Pencil className="size-3" />
            </Button>
          </div>
        );
      })}

      {onOpenSettings && (
        <button
          className="flex w-full items-center gap-2 rounded-md px-[13px] py-1.5 text-muted-foreground text-sm transition-colors hover:bg-muted/50 hover:text-foreground"
          disabled={disabled}
          onClick={onOpenSettings}
          type="button"
        >
          <Settings className="size-4 shrink-0" />
          <span>Manage all connections</span>
        </button>
      )}
    </div>
  );
}
