"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, type Integration } from "@/lib/api-client";
import {
  DatabaseConnectionForm,
  detectDefaultTab,
  validateDatabaseConfig,
  type DatabaseTab,
} from "@/components/database-connection-form";
import { getCustomIntegrationFormHandler } from "@/lib/workflow/editor/extension-registry";
import type { IntegrationConfig } from "@/lib/types/integration";
import { getIntegration, getIntegrationLabels } from "@/plugins/registry";
import { ConfirmOverlay } from "./confirm-overlay";
import { Overlay } from "./overlay";
import { useOverlay } from "./overlay-provider";

const SYSTEM_INTEGRATION_LABELS: Record<string, string> = {
  database: "Database",
};

const getLabel = (type: string): string => {
  const labels = getIntegrationLabels() as Record<string, string>;
  return labels[type] || SYSTEM_INTEGRATION_LABELS[type] || type;
};

function normalizeConfig(c: IntegrationConfig): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(c)) {
    const v = c[key];
    out[key] = v === undefined || v === null ? "" : String(v);
  }
  return out;
}

type IntegrationWithOptionalConfig = Integration & {
  config?: IntegrationConfig;
};

type EditConnectionOverlayProps = {
  overlayId: string;
  integration: Integration;
  onSuccess?: () => void;
  onDelete?: () => void;
};

/**
 * Overlay for editing an existing connection
 */
export function EditConnectionOverlay({
  overlayId,
  integration,
  onSuccess,
  onDelete,
}: EditConnectionOverlayProps) {
  const { push, closeAll } = useOverlay();
  const integrationWithConfig = integration as IntegrationWithOptionalConfig;
  const hasConfigFromProps =
    integrationWithConfig.config != null &&
    typeof integrationWithConfig.config === "object" &&
    !Array.isArray(integrationWithConfig.config);
  const [loading, setLoading] = useState(!hasConfigFromProps);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [name, setName] = useState(integration.name);
  const [config, setConfig] = useState<Record<string, string>>(() => {
    if (hasConfigFromProps && integrationWithConfig.config) {
      return normalizeConfig(integrationWithConfig.config);
    }
    return {};
  });
  const [dbTab, setDbTab] = useState<DatabaseTab>(() => {
    if (hasConfigFromProps && integrationWithConfig.config) {
      return detectDefaultTab(normalizeConfig(integrationWithConfig.config));
    }
    return "url";
  });

  useEffect(() => {
    if (hasConfigFromProps && integrationWithConfig.config) {
      setName(integration.name);
      const normalized = normalizeConfig(integrationWithConfig.config);
      setConfig(normalized);
      if (integration.type === "database") {
        setDbTab(detectDefaultTab(normalized));
      }
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api.integration
      .get(integration.id)
      .then((full) => {
        if (cancelled) {
          return;
        }
        setName(full.name);
        const normalized = normalizeConfig(full.config);
        setConfig(normalized);
        if (integration.type === "database") {
          setDbTab(detectDefaultTab(normalized));
        }
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setLoading(false);
        toast.error("Failed to load connection");
      });
    return () => {
      cancelled = true;
    };
  }, [
    integration.id,
    integration.name,
    integration.type,
    hasConfigFromProps,
    integrationWithConfig.config,
  ]);

  const updateConfig = (key: string, value: string) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
  };

  // For database integrations, secret fields (password, url) are stripped from
  // the server response. We check if the user entered new secret values to
  // decide whether to test client-side or use the server-side test endpoint.
  const hasNewDatabaseSecrets =
    integration.type === "database" &&
    ((config.password ?? "").length > 0 || (config.url ?? "").length > 0);

  /**
   * Returns a validation error message if the current config is invalid for
   * testing or saving, or null if the config is valid. For database integrations
   * without new secret values, validation is skipped (server-side test/merge).
   */
  const getConfigValidationError = (): string | null => {
    if (integration.type !== "database") {
      return null;
    }
    if (!hasNewDatabaseSecrets) {
      return null;
    }
    return validateDatabaseConfig(config, dbTab);
  };

  /**
   * Build non-empty config for sending as overrides to the server-side test.
   */
  const getNonEmptyConfig = (): Record<string, string> => {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(config)) {
      if (value && value.length > 0) {
        result[key] = value;
      }
    }
    return result;
  };

  const doSave = async () => {
    try {
      setSaving(true);
      const nonEmptyConfig = getNonEmptyConfig();
      const hasNewConfig = Object.keys(nonEmptyConfig).length > 0;
      await api.integration.update(integration.id, {
        name: name.trim(),
        ...(hasNewConfig ? { config: nonEmptyConfig } : {}),
      });
      toast.success("Connection updated");
      onSuccess?.();
      closeAll();
    } catch {
      toast.error("Failed to update connection");
    } finally {
      setSaving(false);
    }
  };

  const runConnectionTest = (): Promise<{
    status: "success" | "error";
    message: string;
  }> => {
    // For database integrations, always test server-side. The server merges
    // any config overrides with stored secrets before testing.
    if (integration.type === "database") {
      const overrides = getNonEmptyConfig();
      return api.integration.testConnection(
        integration.id,
        Object.keys(overrides).length > 0 ? overrides : undefined
      );
    }
    const hasNewConfig = Object.values(config).some((v) => v && v.length > 0);
    if (hasNewConfig) {
      return api.integration.testCredentials({
        type: integration.type,
        config,
      });
    }
    return api.integration.testConnection(integration.id);
  };

  /**
   * Returns true when there is no config to test (name-only change for
   * non-database integrations). Database integrations always test server-side.
   */
  const shouldSkipPreSaveTest = (): boolean => {
    if (integration.type === "database") {
      return false;
    }
    const hasNewConfig = Object.values(config).some((v) => v && v.length > 0);
    return !hasNewConfig;
  };

  const handleSave = async () => {
    if (saving) {
      return;
    }

    if (shouldSkipPreSaveTest()) {
      await doSave();
      return;
    }

    const validationError = getConfigValidationError();
    if (validationError) {
      toast.error(validationError);
      return;
    }

    setSaving(true);
    try {
      const result = await runConnectionTest();

      if (result.status === "error") {
        setSaving(false);
        push(ConfirmOverlay, {
          title: "Connection Test Failed",
          message: `The test failed: ${result.message}\n\nDo you want to save anyway?`,
          confirmLabel: "Save Anyway",
          onConfirm: async () => {
            await doSave();
          },
        });
        return;
      }

      await doSave();
    } catch (error) {
      setSaving(false);
      const message =
        error instanceof Error ? error.message : "Failed to test connection";
      push(ConfirmOverlay, {
        title: "Connection Test Failed",
        message: `${message}\n\nDo you want to save anyway?`,
        confirmLabel: "Save Anyway",
        onConfirm: async () => {
          await doSave();
        },
      });
    }
  };

  const handleTest = async () => {
    if (testing) {
      return;
    }
    const validationError = getConfigValidationError();
    if (validationError) {
      toast.error(validationError);
      return;
    }

    setTesting(true);
    try {
      const result = await runConnectionTest();
      if (result.status === "success") {
        toast.success(result.message || "Connection successful");
      } else {
        toast.error(result.message || "Connection failed");
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Connection test failed";
      toast.error(message);
    } finally {
      setTesting(false);
    }
  };

  const handleDelete = () => {
    push(DeleteConnectionOverlay, {
      integration,
      onSuccess: () => {
        onDelete?.();
        closeAll();
      },
    });
  };

  // Get plugin form fields
  const plugin = getIntegration(integration.type);
  const formFields = plugin?.formFields;

  // Render config fields
  const renderConfigFields = () => {
    const customHandler = getCustomIntegrationFormHandler(integration.type);
    if (customHandler) {
      return customHandler({
        integrationType: integration.type,
        isEditMode: true,
        config,
        updateConfig,
      });
    }

    if (integration.type === "database") {
      return (
        <DatabaseConnectionForm
          config={config}
          defaultTab={dbTab}
          isEditMode
          onTabChange={setDbTab}
          updateConfig={updateConfig}
        />
      );
    }

    if (!formFields) {
      return null;
    }

    return formFields.map((field) => (
      <div className="space-y-2" key={field.id}>
        <Label htmlFor={field.id}>{field.label}</Label>
        <Input
          id={field.id}
          onChange={(e) => updateConfig(field.configKey, e.target.value)}
          placeholder={field.placeholder}
          type={field.type}
          value={config[field.configKey] || ""}
        />
        {(field.helpText || field.helpLink) && (
          <p className="text-muted-foreground text-xs">
            {field.helpText}
            {field.helpLink && (
              <a
                className="underline hover:text-foreground"
                href={field.helpLink.url}
                rel="noopener noreferrer"
                target="_blank"
              >
                {field.helpLink.text}
              </a>
            )}
          </p>
        )}
      </div>
    ));
  };

  return (
    <Overlay
      actions={[
        {
          label: "Delete",
          variant: "ghost",
          onClick: handleDelete,
          disabled: loading || saving || testing,
        },
        {
          label: "Test",
          variant: "outline",
          onClick: handleTest,
          loading: testing,
          disabled: loading || saving,
        },
        {
          label: "Update",
          onClick: handleSave,
          loading: saving,
          disabled: loading,
        },
      ]}
      overlayId={overlayId}
      title={`Edit ${getLabel(integration.type)}`}
    >
      <p className="-mt-2 mb-4 text-muted-foreground text-sm">
        Update your connection credentials
      </p>

      {loading ? (
        <div className="flex items-center gap-2 py-8 text-muted-foreground">
          <div className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
          <span className="text-sm">Loading connection...</span>
        </div>
      ) : (
        <div className="space-y-4">
          {renderConfigFields()}

          <div className="space-y-2">
            <Label htmlFor="name">Label (Optional)</Label>
            <Input
              id="name"
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Production, Personal, Work"
              value={name}
            />
          </div>
        </div>
      )}
    </Overlay>
  );
}

type DeleteConnectionOverlayProps = {
  overlayId: string;
  integration: Integration;
  onSuccess?: () => void;
};

/**
 * Overlay for deleting a connection with optional key revocation
 */
export function DeleteConnectionOverlay({
  overlayId,
  integration,
  onSuccess,
}: DeleteConnectionOverlayProps) {
  const { pop } = useOverlay();
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async () => {
    if (deleting) {
      return;
    }
    setDeleting(true);
    try {
      await api.integration.delete(integration.id);
      toast.success("Connection deleted");
      onSuccess?.();
    } catch (_error) {
      toast.error("Failed to delete connection");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Overlay
      actions={[
        { label: "Cancel", variant: "outline", onClick: pop },
        {
          label: "Delete",
          variant: "destructive",
          onClick: handleDelete,
          loading: deleting,
        },
      ]}
      overlayId={overlayId}
      title="Delete Connection"
    >
      <p className="text-muted-foreground text-sm">
        Are you sure you want to delete this connection? Workflows using it will
        fail until a new one is configured.
      </p>
    </Overlay>
  );
}
