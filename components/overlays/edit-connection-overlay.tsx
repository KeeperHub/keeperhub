"use client";

import { useEffect, useState } from "react";
import { ExclusiveGroupHeading } from "@/components/overlays/exclusive-group-heading";
import {
  type ExclusiveGroup,
  isFieldLocked,
  resolveExclusiveGroups,
} from "@/lib/integrations/exclusive-groups";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, type Integration } from "@/lib/api-client";
import { SecretField } from "@/components/secret-field";
import {
  DatabaseConnectionForm,
  detectDefaultTab,
  validateDatabaseConfig,
  type DatabaseTab,
} from "@/components/database-connection-form";
import { getSecretConfigKeys } from "@/lib/integrations/secret-fields";
import { SYSTEM_INTEGRATION_LABELS } from "@/lib/integrations/system";
import { getCustomIntegrationFormHandler } from "@/lib/workflow/editor/extension-registry";
import type { IntegrationConfig } from "@/lib/types/integration";
import { getIntegration, getIntegrationLabels } from "@/plugins/registry";
import { ConfirmOverlay } from "./confirm-overlay";
import { Overlay } from "./overlay";
import { useOverlay } from "./overlay-provider";

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

type PluginFormField = {
  helpText?: string;
  helpLink?: { text: string; url: string };
};

function renderFieldHelp(field: PluginFormField): React.ReactNode {
  if (!(field.helpText || field.helpLink)) {
    return null;
  }
  return (
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
  );
}

/** Stands in for a stored secret the browser is never sent. Never rendered. */
const STORED_SECRET_PLACEHOLDER = "\u0000stored";

type EditConnectionOverlayProps = {
  overlayId: string;
  integration: Integration;
  onSuccess?: () => void;
  onDelete?: () => void;
};

/**
 * Credential form for an existing connection. Rendered inline in settings;
 * the overlay below is the legacy wrapper around the same form.
 */
export function EditConnectionForm({
  integration,
  onSuccess,
  onDelete,
  onCancel,
  inline = false,
}: {
  integration: Integration;
  onSuccess?: () => void;
  onDelete?: () => void;
  onCancel?: () => void;
  /** Renders its own Test and Update buttons instead of overlay actions. */
  inline?: boolean;
}) {
  const { push, closeAll } = useOverlay();
  // Config always comes from the fetch below: `GET /api/integrations`
  // excludes it deliberately, so a props shortcut could only ever be a path
  // where `storedSecrets` was never populated.
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [name, setName] = useState(integration.name);
  const [config, setConfig] = useState<Record<string, string>>({});
  const [dbTab, setDbTab] = useState<DatabaseTab>("url");

  useEffect(() => {
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
        setStoredSecrets(full.storedSecretKeys ?? []);
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
  }, [integration.id, integration.name, integration.type]);

  /**
   * Stored credentials the user has asked to remove.
   *
   * A blank secret field means "unchanged", because the stored value is never
   * sent to the browser and so cannot be resent - which left no way to take a
   * credential away. Removing is therefore its own act rather than an empty
   * field, and typing a replacement cancels it.
   */
  const [clearedKeys, setClearedKeys] = useState<Set<string>>(new Set());

  /** Secret keys the connection holds a value for. Values never come down. */
  const [storedSecrets, setStoredSecrets] = useState<string[]>([]);

  const updateConfig = (key: string, value: string) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
    if (value.length > 0) {
      setClearedKeys((prev) => {
        if (!prev.has(key)) {
          return prev;
        }
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  const markCleared = (key: string) => {
    setConfig((prev) => ({ ...prev, [key]: "" }));
    setClearedKeys((prev) => new Set(prev).add(key));
  };

  // Credential values are never sent to the client, so a secret field starts
  // blank and stays blank unless the user replaces it.
  const secretKeys = getSecretConfigKeys(integration.type) ?? new Set<string>();
  const hasNewSecrets = [...secretKeys].some(
    (key) => (config[key] ?? "").length > 0
  );

  /**
   * Returns a validation error message if the current config is invalid for
   * testing or saving, or null if the config is valid. For database integrations
   * without new secret values, validation is skipped (server-side test/merge).
   */
  const getConfigValidationError = (): string | null => {
    if (integration.type !== "database") {
      return null;
    }
    if (!hasNewSecrets) {
      return null;
    }
    return validateDatabaseConfig(config, dbTab);
  };

  /**
   * What to store.
   *
   * A blank secret is dropped, because the client is never given the stored
   * one and a blank field means it was left alone. Everything else is sent as
   * the form shows it, blank included - those values did come down to the
   * browser, so a field the user emptied was emptied on purpose, and dropping
   * it here made From email and Account subdomain impossible to clear.
   */
  const getConfigForSave = (): Record<string, string> => {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(config)) {
      const isSecret = secretKeys.has(key);
      if (isSecret ? value && value.length > 0 : !clearedKeys.has(key)) {
        result[key] = value ?? "";
      }
    }
    return result;
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
      const configForSave = getConfigForSave();
      const cleared = [...clearedKeys];
      const hasNewConfig = Object.keys(configForSave).length > 0;
      await api.integration.update(integration.id, {
        name: name.trim(),
        ...(hasNewConfig ? { config: configForSave } : {}),
        ...(cleared.length > 0 ? { clearedConfigKeys: cleared } : {}),
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
    // Always test server-side. The stored credential never leaves the server,
    // and any value the user typed is merged over it before the test runs.
    // What the save will store, not what was typed. These differ for a
    // non-secret field somebody emptied - Account subdomain, From email -
    // which the save keeps as blank and the old payload dropped, so the
    // server filled it back in from storage and the test passed against a
    // value that was about to be erased.
    const overrides = getConfigForSave();
    const cleared = [...clearedKeys];
    // The pending removals go with it. The server fills anything not sent
    // from what is stored, so a test that did not know about them
    // authenticated with the credential the save was about to delete and came
    // back green.
    return api.integration.testConnection(
      integration.id,
      Object.keys(overrides).length > 0 ? overrides : undefined,
      cleared.length > 0 ? cleared : undefined
    );
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
    // A pending removal changes what the connection will authenticate with,
    // which is exactly what the test is for.
    return !(hasNewConfig || clearedKeys.size > 0);
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

    const renderedFields = formFields.map((field) => {
      const help = renderFieldHelp(field);
      if (field.type === "password") {
        return (
          <SecretField
            configKey={field.configKey}
            fieldId={field.id}
            helpNode={help}
            isEditMode
            key={field.id}
            label={field.label}
            onChange={updateConfig}
            placeholder={field.placeholder}
            value={config[field.configKey] || ""}
          />
        );
      }
      if (field.type === "checkbox") {
        // A checkbox binds `checked`, not `value`. An empty string means
        // unset rather than false: that is what every connection saved before
        // this branch holds, and a plugin whose box defaults on would show
        // unticked while behaving as ticked.
        const stored = config[field.configKey];
        const checked =
          stored === undefined || stored === ""
            ? Boolean(field.defaultValue)
            : stored === "true";
        return (
          <div className="space-y-2" key={field.id}>
            <div className="flex items-center gap-2">
              <input
                checked={checked}
                className="size-4 rounded border-input accent-primary"
                id={field.id}
                onChange={(e) =>
                  updateConfig(field.configKey, String(e.target.checked))
                }
                type="checkbox"
              />
              <Label htmlFor={field.id}>{field.label}</Label>
            </div>
            {help}
          </div>
        );
      }

      return (
        <div className="space-y-2" key={field.id}>
          <Label htmlFor={field.id}>{field.label}</Label>
          <Input
            id={field.id}
            onChange={(e) => updateConfig(field.configKey, e.target.value)}
            placeholder={field.placeholder}
            type={field.type}
            value={config[field.configKey] || ""}
          />
          {help}
        </div>
      );
    });

    // A stored secret stands in for its value, which the browser is never
    // sent, so every state resolves from values. The fields do not render
    // until the fetch resolves, so an empty `storedSecrets` is an answer.
    const knownConfig: Record<string, unknown> = { ...config };
    for (const key of storedSecrets) {
      if (!(knownConfig[key] as string | undefined)?.length) {
        knownConfig[key] = STORED_SECRET_PLACEHOLDER;
      }
    }
    const exclusive = resolveExclusiveGroups(formFields, knownConfig);
    // Groups that hold a credential, not groups that exist: a form declaring
    // one credential group beside a group of ordinary settings would
    // otherwise offer removal on its only credential, which is the case this
    // deliberately excludes.
    const credentialGroupCount = exclusive.groups.filter((group) =>
      group.configKeys.some((key) => secretKeys.has(key))
    ).length;
    const useThisInstead = (group: ExclusiveGroup) => {
      const inUse = exclusive.groups.find(
        (one) => one.id === exclusive.activeGroupId
      );
      for (const key of inUse?.configKeys ?? []) {
        // Emptying the field is not enough for a stored secret: a blank one
        // means "unchanged" on the way back, so the credential being switched
        // away from has to be marked for removal or the run time would go on
        // preferring it.
        if (storedSecrets.includes(key)) {
          markCleared(key);
        } else {
          updateConfig(key, "");
        }
      }
    };

    return renderedFields.map((rendered, index) => {
      const field = formFields[index];
      const heading = exclusive.groups.find(
        (group) => group.firstFieldId === field.id
      );
      const locked = isFieldLocked(field, exclusive);
      // Only where the form holds an alternative, because a blank field means
      // "unchanged" for a secret and removing a connection's sole credential
      // would leave one that still selects on a node and fails every run.
      const removable =
        secretKeys.has(field.configKey) &&
        Boolean(field.exclusiveGroup) &&
        credentialGroupCount > 1;
      const cleared = clearedKeys.has(field.configKey);
      if (!(heading || locked || removable)) {
        return rendered;
      }
      return (
        <div className="space-y-2" key={field.id}>
          {heading && (
            <ExclusiveGroupHeading
              group={heading}
              onUseThisInstead={useThisInstead}
              state={exclusive}
            />
          )}
          <div
            aria-hidden={locked}
            className={locked ? "pointer-events-none opacity-45" : undefined}
          >
            {rendered}
            {removable && !locked && (
              // No left margin: this sits under the field's own help line,
              // which has none.
              <div className="mt-1">
                {cleared ? (
                  <span className="text-muted-foreground text-xs">
                    Will be removed when you save. Type a new value to keep this
                    credential instead.
                  </span>
                ) : (
                  <button
                    className="text-muted-foreground text-xs underline hover:text-foreground"
                    onClick={() => markCleared(field.configKey)}
                    type="button"
                  >
                    Remove the stored value
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      );
    });
  };

  return (
    <>
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

      {inline && !loading && (
        <div className="flex items-center justify-end gap-2 pt-4">
          {onCancel && (
            <Button onClick={onCancel} size="sm" variant="ghost">
              Cancel
            </Button>
          )}
          <Button
            disabled={saving}
            onClick={handleTest}
            size="sm"
            variant="outline"
          >
            {testing ? "Testing..." : "Test"}
          </Button>
          <Button disabled={saving} onClick={handleSave} size="sm">
            {saving ? "Saving..." : "Update"}
          </Button>
        </div>
      )}
    </>
  );
}

export function EditConnectionOverlay({
  overlayId,
  integration,
  onSuccess,
  onDelete,
}: EditConnectionOverlayProps) {
  return (
    <Overlay
      overlayId={overlayId}
      title={`Edit ${getLabel(integration.type)}`}
    >
      <p className="-mt-2 mb-4 text-muted-foreground text-sm">
        Update your connection credentials
      </p>
      <EditConnectionForm
        inline
        integration={integration}
        onDelete={onDelete}
        onSuccess={onSuccess}
      />
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
