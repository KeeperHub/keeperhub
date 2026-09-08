"use client";

import { useAtomValue } from "jotai";
import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { AuthDialog } from "@/components/auth/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { IntegrationIcon } from "@/components/ui/integration-icon";
import { Label } from "@/components/ui/label";
import { useIsMobile } from "@/hooks/use-mobile";
import { api } from "@/lib/api-client";
import { integrationRequiresCredentials } from "@/lib/integration-helpers";
import { useSession } from "@/lib/auth-client";
import {
  DatabaseConnectionForm,
  validateDatabaseConfig,
  type DatabaseTab,
} from "@/components/database-connection-form";
import { getCustomIntegrationFormHandler } from "@/lib/workflow/editor/extension-registry";
import { integrationsAtom } from "@/lib/integrations-store";
import type { IntegrationType } from "@/lib/types/integration";
import {
  getIntegration,
  getIntegrationLabels,
  getSortedIntegrationTypes,
} from "@/plugins/registry";
import { getIntegrationDescriptions } from "@/plugins/registry";
import { ConfirmOverlay } from "./confirm-overlay";
import { Overlay } from "./overlay";
import { OverlayFooter } from "./overlay-footer";
import { useOverlay } from "./overlay-provider";

// System integrations that don't have plugins
const SYSTEM_INTEGRATION_TYPES: IntegrationType[] = ["database"];
const SYSTEM_INTEGRATION_LABELS: Record<string, string> = {
  database: "Database",
};
const SYSTEM_INTEGRATION_DESCRIPTIONS: Record<string, string> = {
  database: "Connect to PostgreSQL databases",
};

// Get all integration types (plugins + system)
const getIntegrationTypes = (): IntegrationType[] => [
  ...getSortedIntegrationTypes(),
  ...SYSTEM_INTEGRATION_TYPES,
];

// Get label for any integration type
const getLabel = (type: IntegrationType): string =>
  getIntegrationLabels()[type] || SYSTEM_INTEGRATION_LABELS[type] || type;

// Get description for any integration type
const getDescription = (type: IntegrationType): string =>
  getIntegrationDescriptions()[type] ||
  SYSTEM_INTEGRATION_DESCRIPTIONS[type] ||
  "";

type AddConnectionOverlayProps = {
  overlayId: string;
  onSuccess?: (integrationId: string) => void;
};

/**
 * Overlay for selecting a connection type to add
 */
/** Service picker. Used inline in settings and by the legacy overlay. */
export function ConnectionTypePicker({
  onSelect,
}: {
  onSelect: (type: IntegrationType) => void;
}): React.ReactElement {
  const [searchQuery, setSearchQuery] = useState("");
  const isMobile = useIsMobile();

  const existingIntegrations = useAtomValue(integrationsAtom);
  const existingIntegrationTypes = useMemo(
    () => new Set(existingIntegrations.map((i) => i.type)),
    [existingIntegrations]
  );

  // Most plugins are protocols and utility nodes that hold no credentials, so
  // there is nothing to connect: listing them here only buried the handful of
  // services that do take credentials.
  const connectableTypes = useMemo(
    () => getIntegrationTypes().filter(integrationRequiresCredentials),
    []
  );

  const filteredTypes = useMemo(() => {
    if (!searchQuery.trim()) {
      return connectableTypes;
    }
    const query = searchQuery.toLowerCase();
    return connectableTypes.filter((type) =>
      getLabel(type).toLowerCase().includes(query)
    );
  }, [connectableTypes, searchQuery]);

  const isAlreadyConfigured = (type: IntegrationType) => {
    const plugin = getIntegration(type);
    return plugin?.singleConnection && existingIntegrationTypes.has(type);
  };

  const handleSelectType = (type: IntegrationType): void => {
    onSelect(type);
  };

  return (
      <div className="space-y-3">
        <div className="relative">
          <Search className="-translate-y-1/2 absolute top-1/2 left-3 size-4 text-muted-foreground" />
          <Input
            autoFocus={!isMobile}
            className="pl-9"
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search services..."
            value={searchQuery}
          />
        </div>
        <div className="max-h-[300px] space-y-1 overflow-y-auto">
          {filteredTypes.length === 0 ? (
            <p className="py-4 text-center text-muted-foreground text-sm">
              No services found
            </p>
          ) : (
            filteredTypes.map((type) => {
              const description = getDescription(type);
              // or integrations that don't require credentials
              const configured = isAlreadyConfigured(type);
              const isDisabled = configured;
              return (
                <button
                  className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors ${
                    isDisabled
                      ? "cursor-not-allowed opacity-50"
                      : "hover:bg-muted/50"
                  }`}
                  disabled={isDisabled}
                  key={type}
                  onClick={() => handleSelectType(type)}
                  type="button"
                >
                  <IntegrationIcon
                    className="size-5 shrink-0"
                    integration={type}
                  />
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-medium">{getLabel(type)}</span>
                    {configured && (
                      <span className="ml-1 text-muted-foreground text-xs">
                        (Configured)
                      </span>
                    )}
                    {description && (
                      <span className="text-muted-foreground text-xs">
                        {" "}
                        - {description}
                      </span>
                    )}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>
  );
}

export function AddConnectionOverlay({
  overlayId,
  onSuccess,
}: AddConnectionOverlayProps) {
  const { push } = useOverlay();
  return (
    <Overlay overlayId={overlayId} title="Add Connection">
      <p className="-mt-2 mb-4 text-muted-foreground text-sm">
        Select a service to connect
      </p>
      <ConnectionTypePicker
        onSelect={(type) => push(ConfigureConnectionOverlay, { type, onSuccess })}
      />
    </Overlay>
  );
}

type ConfigureConnectionOverlayProps = {
  overlayId: string;
  type: IntegrationType;
  onSuccess?: (integrationId: string) => void;
};

/**
 * Secret field component for password inputs
 */
function SecretField({
  fieldId,
  label,
  configKey,
  placeholder,
  helpText,
  helpLink,
  value,
  onChange,
}: {
  fieldId: string;
  label: string;
  configKey: string;
  placeholder?: string;
  helpText?: string;
  helpLink?: { url: string; text: string };
  value: string;
  onChange: (key: string, value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={fieldId}>{label}</Label>
      <Input
        className="flex-1"
        id={fieldId}
        onChange={(e) => onChange(configKey, e.target.value)}
        placeholder={placeholder}
        type="password"
        value={value}
      />
      {(helpText || helpLink) && (
        <p className="text-muted-foreground text-xs">
          {helpText}
          {helpLink && (
            <a
              className="underline hover:text-foreground"
              href={helpLink.url}
              rel="noopener noreferrer"
              target="_blank"
            >
              {helpLink.text}
            </a>
          )}
        </p>
      )}
    </div>
  );
}

/**
 * Overlay for configuring a new connection
 */
/**
 * Credential form for one service. Rendered inline in settings; the overlay
 * below is the legacy wrapper around the same form.
 */
export function ConfigureConnectionForm({
  type,
  onSuccess,
  onCancel,
  inline = false,
}: {
  type: IntegrationType;
  onSuccess?: (integrationId: string) => void;
  onCancel?: () => void;
  /** Renders its own Test/Create buttons instead of relying on overlay actions. */
  inline?: boolean;
}): React.ReactElement {
  const { push, closeAll } = useOverlay();
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [name, setName] = useState("");
  const [config, setConfig] = useState<Record<string, string>>({});
  const [dbTab, setDbTab] = useState<DatabaseTab>("url");
  const { data: session } = useSession();
  const isAnonymous =
    type === "web3" &&
    (!session?.user ||
      session.user.name === "Anonymous" ||
      session.user.email?.includes("@http://") ||
      session.user.email?.includes("@https://") ||
      session.user.email?.startsWith("temp-"));

  const updateConfig = (key: string, value: string) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
  };

  const doSave = async () => {
    try {
      setSaving(true);
      const newIntegration = await api.integration.create({
        name: name.trim(),
        type,
        config,
      });
      toast.success("Connection created");
      onSuccess?.(newIntegration.id);
      closeAll();
    } catch {
      toast.error("Failed to save connection");
    } finally {
      setSaving(false);
    }
  };

  const showSaveAnywayConfirm = (message: string) => {
    push(ConfirmOverlay, {
      title: "Connection Test Failed",
      message: `${message}\n\nDo you want to save anyway?`,
      confirmLabel: "Save Anyway",
      onConfirm: async () => {
        await doSave();
      },
    });
  };

  const validateAndRunSave = async () => {
    const result = await api.integration.testCredentials({ type, config });
    if (result.status === "error") {
      setSaving(false);
      showSaveAnywayConfirm(result.message);
      return;
    }
    await doSave();
  };

  const handleSave = async () => {
    if (saving) {
      return;
    }
    if (type === "database") {
      const dbError = validateDatabaseConfig(config, dbTab);
      if (dbError) {
        toast.error(dbError);
        return;
      }
    } else {
      const hasConfig = Object.values(config).some((v) => v && v.length > 0);
      if (!hasConfig) {
        toast.error("Please enter credentials");
        return;
      }
    }

    setSaving(true);
    try {
      await validateAndRunSave();
    } catch (error) {
      setSaving(false);
      const message =
        error instanceof Error ? error.message : "Failed to test connection";
      showSaveAnywayConfirm(message);
    }
  };

  const getTestConfigError = (): string | null => {
    if (type === "database") {
      return validateDatabaseConfig(config, dbTab);
    }
    const hasConfig = Object.values(config).some((v) => v && v.length > 0);
    if (!hasConfig) {
      return "Please enter credentials first";
    }
    return null;
  };

  const handleTest = async () => {
    if (testing) {
      return;
    }
    const err = getTestConfigError();
    if (err) {
      toast.error(err);
      return;
    }
    setTesting(true);
    try {
      const result = await api.integration.testCredentials({ type, config });
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

  // Get plugin form fields
  const plugin = getIntegration(type);
  const formFields = plugin?.formFields;

  // Render config fields
  const renderConfigFields = () => {
    const customHandler = getCustomIntegrationFormHandler(type);
    if (customHandler) {
      return customHandler({
        integrationType: type,
        isEditMode: false,
        config,
        updateConfig,
        onSuccess,
        closeAll,
      });
    }

    if (type === "database") {
      return (
        <DatabaseConnectionForm
          config={config}
          onTabChange={setDbTab}
          updateConfig={updateConfig}
        />
      );
    }

    if (!formFields) {
      return null;
    }

    return formFields.map((field) => {
      if (field.type === "password") {
        return (
          <SecretField
            configKey={field.configKey}
            fieldId={field.id}
            helpLink={field.helpLink}
            helpText={field.helpText}
            key={field.id}
            label={field.label}
            onChange={updateConfig}
            placeholder={field.placeholder}
            value={config[field.configKey] || ""}
          />
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
      );
    });
  };

  const showSignInButton = type === "web3" && isAnonymous;
  // Web3 uses custom form handler with its own Create Wallet button
  const hideOverlayActions = type === "web3";

  return (
    <>
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

      {showSignInButton && (
        <OverlayFooter>
          <AuthDialog>
            <Button>Sign In</Button>
          </AuthDialog>
        </OverlayFooter>
      )}

      {inline && !hideOverlayActions && (
        <div className="flex justify-end gap-2 pt-4">
          {onCancel && (
            <Button onClick={onCancel} variant="ghost">
              Cancel
            </Button>
          )}
          <Button disabled={saving} onClick={handleTest} variant="outline">
            {testing ? "Testing..." : "Test"}
          </Button>
          <Button disabled={saving} onClick={handleSave}>
            {saving ? "Creating..." : "Create"}
          </Button>
        </div>
      )}
    </>
  );
}

export function ConfigureConnectionOverlay({
  overlayId,
  type,
  onSuccess,
}: ConfigureConnectionOverlayProps) {
  return (
    <Overlay overlayId={overlayId} title={`Add ${getLabel(type)}`}>
      <p className="-mt-2 mb-4 text-muted-foreground text-sm">
        Enter your credentials
      </p>
      <ConfigureConnectionForm inline onSuccess={onSuccess} type={type} />
    </Overlay>
  );
}
