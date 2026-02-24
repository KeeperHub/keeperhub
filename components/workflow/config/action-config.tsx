"use client";

import { useAtomValue, useSetAtom } from "jotai";
import { HelpCircle, Plus, Settings } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ConfigureConnectionOverlay } from "@/components/overlays/add-connection-overlay";
import { AiGatewayConsentOverlay } from "@/components/overlays/ai-gateway-consent-overlay";
import { useOverlay } from "@/components/overlays/overlay-provider";
import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/components/ui/code-editor";
import { Input } from "@/components/ui/input";
import { IntegrationIcon } from "@/components/ui/integration-icon";
import { IntegrationSelector } from "@/components/ui/integration-selector";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TemplateBadgeInput } from "@/components/ui/template-badge-input";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { SqlTemplateEditor } from "@/keeperhub/components/ui/sql-template-editor";
// start keeperhub
import { actionRequiresCredentials } from "@/keeperhub/lib/integration-helpers";
// end keeperhub
import { aiGatewayStatusAtom } from "@/lib/ai-gateway/state";
import { validateConditionExpressionUI } from "@/lib/condition-validator";
import {
  integrationsAtom,
  integrationsVersionAtom,
} from "@/lib/integrations-store";
import type { IntegrationType } from "@/lib/types/integration";
// start custom keeperhub code //
import {
  ARRAY_SOURCE_RE,
  extractObjectPaths,
  resolveArraySourceElement,
  traverseDotPath,
} from "@/keeperhub/lib/for-each-utils";
import {
  executionLogsAtom,
  lastExecutionLogsAtom,
  nodesAtom,
} from "@/lib/workflow-store";
// end keeperhub code //
import {
  findActionById,
  getActionsByCategory,
  getAllIntegrations,
  getIntegration,
} from "@/plugins";
import { ActionConfigRenderer } from "./action-config-renderer";
import { SchemaBuilder, type SchemaField } from "./schema-builder";

type ActionConfigProps = {
  config: Record<string, unknown>;
  onUpdateConfig: (key: string, value: string) => void;
  disabled: boolean;
  isOwner?: boolean;
  // start custom keeperhub code //
  nodeId?: string;
  // end keeperhub code //
};

// Database Query fields component
function DatabaseQueryFields({
  config,
  onUpdateConfig,
  disabled,
}: {
  config: Record<string, unknown>;
  onUpdateConfig: (key: string, value: string) => void;
  disabled: boolean;
}) {
  return (
    <>
      {/* start custom keeperhub code */}
      <div className="space-y-2">
        <Label htmlFor="dbQuery">SQL Query</Label>
        <SqlTemplateEditor
          disabled={disabled}
          height="150px"
          onChange={(v) => onUpdateConfig("dbQuery", v)}
          value={(config?.dbQuery as string) || ""}
        />
        <p className="text-muted-foreground text-xs">
          The selected database connection above will be used to execute this
          query. Use @ to insert values from previous nodes.
        </p>
      </div>
      {/* end keeperhub code */}
      <div className="space-y-2">
        <Label>Schema (Optional)</Label>
        <SchemaBuilder
          disabled={disabled}
          onChange={(schema) =>
            onUpdateConfig("dbSchema", JSON.stringify(schema))
          }
          schema={
            config?.dbSchema
              ? (JSON.parse(config.dbSchema as string) as SchemaField[])
              : []
          }
        />
      </div>
    </>
  );
}

// HTTP Request fields component
function HttpRequestFields({
  config,
  onUpdateConfig,
  disabled,
}: {
  config: Record<string, unknown>;
  onUpdateConfig: (key: string, value: string) => void;
  disabled: boolean;
}) {
  return (
    <>
      <div className="space-y-2">
        <Label htmlFor="httpMethod">HTTP Method</Label>
        <Select
          disabled={disabled}
          onValueChange={(value) => onUpdateConfig("httpMethod", value)}
          value={(config?.httpMethod as string) || "POST"}
        >
          <SelectTrigger className="w-full" id="httpMethod">
            <SelectValue placeholder="Select method" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="GET">GET</SelectItem>
            <SelectItem value="POST">POST</SelectItem>
            <SelectItem value="PUT">PUT</SelectItem>
            <SelectItem value="PATCH">PATCH</SelectItem>
            <SelectItem value="DELETE">DELETE</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="endpoint">URL</Label>
        <TemplateBadgeInput
          disabled={disabled}
          id="endpoint"
          onChange={(value) => onUpdateConfig("endpoint", value)}
          placeholder="https://api.example.com/endpoint or {{NodeName.url}}"
          value={(config?.endpoint as string) || ""}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="httpHeaders">Headers (JSON)</Label>
        <div className="overflow-hidden rounded-md border">
          <CodeEditor
            defaultLanguage="json"
            height="100px"
            onChange={(value) => onUpdateConfig("httpHeaders", value || "{}")}
            options={{
              minimap: { enabled: false },
              lineNumbers: "off",
              scrollBeyondLastLine: false,
              fontSize: 12,
              readOnly: disabled,
              wordWrap: "off",
            }}
            value={(config?.httpHeaders as string) || "{}"}
          />
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor="httpBody">Body (JSON)</Label>
        <div
          className={`overflow-hidden rounded-md border ${config?.httpMethod === "GET" ? "opacity-50" : ""}`}
        >
          <CodeEditor
            defaultLanguage="json"
            height="120px"
            onChange={(value) => onUpdateConfig("httpBody", value || "{}")}
            options={{
              minimap: { enabled: false },
              lineNumbers: "off",
              scrollBeyondLastLine: false,
              fontSize: 12,
              readOnly: config?.httpMethod === "GET" || disabled,
              domReadOnly: config?.httpMethod === "GET" || disabled,
              wordWrap: "off",
            }}
            value={(config?.httpBody as string) || "{}"}
          />
        </div>
        {config?.httpMethod === "GET" && (
          <p className="text-muted-foreground text-xs">
            Body is disabled for GET requests
          </p>
        )}
      </div>
    </>
  );
}

// Condition fields component
function ConditionFields({
  config,
  onUpdateConfig,
  disabled,
}: {
  config: Record<string, unknown>;
  onUpdateConfig: (key: string, value: string) => void;
  disabled: boolean;
}) {
  // start custom keeperhub code
  const [validationError, setValidationError] = useState<string | null>(null);
  const conditionValue = (config?.condition as string) || "";

  // Debounced validation - validate after user stops typing
  useEffect(() => {
    if (!conditionValue.trim()) {
      setValidationError(null);
      return;
    }

    const timeoutId = setTimeout(() => {
      const result = validateConditionExpressionUI(conditionValue);
      if (result.valid) {
        setValidationError(null);
      } else {
        setValidationError(result.error);
      }
    }, 400); // 400ms debounce delay

    return () => clearTimeout(timeoutId);
  }, [conditionValue]);
  // end keeperhub code

  return (
    <div className="space-y-2">
      <Label htmlFor="condition">Condition Expression</Label>
      <TemplateBadgeInput
        disabled={disabled}
        id="condition"
        onChange={(value) => onUpdateConfig("condition", value)}
        placeholder="e.g., 5 > 3, status === 200, {{PreviousNode.value}} > 100"
        value={conditionValue}
      />
      {/* start custom keeperhub code */}
      {validationError && (
        <p className="text-xs text-yellow-600">{validationError}</p>
      )}
      {/* end keeperhub code */}
      <p className="text-muted-foreground text-xs">
        Enter a JavaScript expression that evaluates to true or false. You can
        use @ to reference previous node outputs.
      </p>
    </div>
  );
}

// start custom keeperhub code //

/**
 * Extract dot-paths from the first element of the array referenced by arraySource.
 */
export function useArrayItemFields(arraySource: string | undefined): string[] {
  const executionLogs = useAtomValue(executionLogsAtom);
  const lastExecutionLogs = useAtomValue(lastExecutionLogsAtom);
  const nodes = useAtomValue(nodesAtom);

  return useMemo(() => {
    if (!arraySource) {
      return [];
    }

    const first = resolveArraySourceElement(
      arraySource,
      executionLogs,
      lastExecutionLogs.logs,
      nodes
    );
    if (!first) {
      return [];
    }

    const paths: string[] = [];
    extractObjectPaths(first, "", 0, paths);
    return paths;
  }, [arraySource, executionLogs, lastExecutionLogs, nodes]);
}
// end keeperhub code //

/** Sentinel value for the "Full element (no mapping)" select option. */
const FULL_ELEMENT_VALUE = "__full__";

// For Each fields component
function ForEachFields({
  config,
  onUpdateConfig,
  disabled,
}: {
  config: Record<string, unknown>;
  onUpdateConfig: (key: string, value: string) => void;
  disabled: boolean;
}) {
  // start custom keeperhub code //
  const itemFields = useArrayItemFields(
    config?.arraySource as string | undefined
  );
  // end keeperhub code //
  return (
    <>
      <div className="space-y-2">
        <Label htmlFor="arraySource">Array Source</Label>
        <TemplateBadgeInput
          disabled={disabled}
          id="arraySource"
          onChange={(value) => onUpdateConfig("arraySource", value)}
          placeholder="e.g., {{Database Query.rows}} or {{HTTP Request.data.items}}"
          value={(config?.arraySource as string) || ""}
        />
        <p className="text-muted-foreground text-xs">
          Reference an array from a previous node. Use @ to select a field.
        </p>
      </div>
      {/* start custom keeperhub code */}
      <div className="space-y-2">
        <Label htmlFor="mapExpression">Extract Field (optional)</Label>
        {itemFields.length > 0 ? (
          <Select
            disabled={disabled}
            onValueChange={(value) =>
              onUpdateConfig("mapExpression", value === FULL_ELEMENT_VALUE ? "" : value)
            }
            value={(config?.mapExpression as string) || FULL_ELEMENT_VALUE}
          >
            <SelectTrigger id="mapExpression">
              <SelectValue placeholder="Full element" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={FULL_ELEMENT_VALUE}>
                Full element (no mapping)
              </SelectItem>
              <SelectSeparator />
              {itemFields.map((field) => (
                <SelectItem key={field} value={field}>
                  <span className="font-mono text-xs">{field}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Input
            disabled={disabled}
            id="mapExpression"
            onChange={(e) => onUpdateConfig("mapExpression", e.target.value)}
            placeholder="e.g., address or data.name"
            value={(config?.mapExpression as string) || ""}
          />
        )}
        <p className="text-muted-foreground text-xs">
          {itemFields.length > 0
            ? "Pick a field to extract from each element, or keep full element."
            : "Run the workflow once to see available fields, or type a dot-path manually."}
        </p>
      </div>
      {/* end keeperhub code */}
      <div className="space-y-2">
        <Label htmlFor="maxIterations">Max Items (optional)</Label>
        <Input
          disabled={disabled}
          id="maxIterations"
          min={0}
          onChange={(e) => {
            const raw = e.target.value.replace(/[^0-9]/g, "");
            onUpdateConfig("maxIterations", raw);
          }}
          placeholder="All"
          type="number"
          value={(config?.maxIterations as string) || ""}
        />
        <p className="text-muted-foreground text-xs">
          Leave empty or set to 0 to process all items. Negative values are not
          allowed.
        </p>
      </div>
      {/* start custom keeperhub code */}
      <div className="space-y-2">
        <Label htmlFor="concurrency">Concurrency</Label>
        <Select
          disabled={disabled}
          onValueChange={(value) => {
            onUpdateConfig("concurrency", value);
            if (value !== "custom") {
              onUpdateConfig("concurrencyLimit", "");
            }
          }}
          value={(config?.concurrency as string) || "sequential"}
        >
          <SelectTrigger id="concurrency">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="sequential">Sequential (one at a time)</SelectItem>
            <SelectItem value="parallel">Parallel (all at once)</SelectItem>
            <SelectItem value="custom">Custom limit</SelectItem>
          </SelectContent>
        </Select>
        {(config?.concurrency as string) === "custom" && (
          <Input
            disabled={disabled}
            id="concurrencyLimit"
            min={2}
            onChange={(e) => {
              const raw = e.target.value.replace(/[^0-9]/g, "");
              onUpdateConfig("concurrencyLimit", raw);
            }}
            placeholder="e.g., 5"
            type="number"
            value={(config?.concurrencyLimit as string) || ""}
          />
        )}
        <p className="text-muted-foreground text-xs">
          Sequential runs one iteration at a time. Parallel runs all at once.
          Custom limit runs up to N iterations concurrently.
        </p>
      </div>
      {/* end keeperhub code */}
      <div className="rounded-lg border bg-muted/30 p-3">
        <p className="text-muted-foreground text-sm">
          Connect action nodes after this For Each to define the loop body.
          Optionally end with a Collect node to aggregate results. Without
          Collect, the loop runs as fire-and-forget. Inside the loop, use @ to
          reference <code className="text-xs">For Each.currentItem</code> for
          the current element and{" "}
          <code className="text-xs">For Each.index</code> for the iteration
          index.
        </p>
      </div>
    </>
  );
}

// Collect fields component (informational only)
function CollectFields() {
  return (
    <div className="space-y-3">
      <div className="rounded-lg border bg-muted/30 p-3">
        <p className="text-muted-foreground text-sm">
          Place this node after a For Each loop to gather iteration outputs into
          a single array. The Collect node marks the end of the loop body --
          nodes connected after Collect run once with the aggregated results.
        </p>
      </div>
      <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
        <p className="font-medium text-sm">Available outputs</p>
        <ul className="list-disc space-y-1 pl-4 text-muted-foreground text-sm">
          <li>
            <code className="text-xs">Collect.results</code> -- Array of
            outputs, one entry per iteration (from the last body node before
            Collect)
          </li>
          <li>
            <code className="text-xs">Collect.count</code> -- Number of
            completed iterations
          </li>
        </ul>
        <p className="text-muted-foreground text-xs">
          Without a Collect node, the loop runs as fire-and-forget with no
          aggregated output.
        </p>
      </div>
    </div>
  );
}

// end keeperhub code //

// System action fields wrapper - extracts conditional rendering to reduce complexity
function SystemActionFields({
  actionType,
  config,
  onUpdateConfig,
  disabled,
}: {
  actionType: string;
  config: Record<string, unknown>;
  onUpdateConfig: (key: string, value: string) => void;
  disabled: boolean;
}) {
  switch (actionType) {
    case "HTTP Request":
      return (
        <HttpRequestFields
          config={config}
          disabled={disabled}
          onUpdateConfig={onUpdateConfig}
        />
      );
    case "Database Query":
      return (
        <DatabaseQueryFields
          config={config}
          disabled={disabled}
          onUpdateConfig={onUpdateConfig}
        />
      );
    case "Condition":
      return (
        <ConditionFields
          config={config}
          disabled={disabled}
          onUpdateConfig={onUpdateConfig}
        />
      );
    // start custom keeperhub code //
    case "For Each":
      return (
        <ForEachFields
          config={config}
          disabled={disabled}
          onUpdateConfig={onUpdateConfig}
        />
      );
    case "Collect":
      return <CollectFields />;
    // end keeperhub code //
    default:
      return null;
  }
}

// System actions that don't have plugins
const SYSTEM_ACTIONS: Array<{ id: string; label: string }> = [
  { id: "HTTP Request", label: "HTTP Request" },
  { id: "Database Query", label: "Database Query" },
  { id: "Condition", label: "Condition" },
  // start custom keeperhub code //
  { id: "For Each", label: "For Each" },
  { id: "Collect", label: "Collect" },
  // end keeperhub code //
];

const SYSTEM_ACTION_IDS = SYSTEM_ACTIONS.map((a) => a.id);

// System actions that need integrations (not in plugin registry)
const SYSTEM_ACTION_INTEGRATIONS: Record<string, IntegrationType> = {
  "Database Query": "database",
};

// Build category mapping dynamically from plugins + System
function useCategoryData() {
  // start custom keeperhub code //
  const nodes = useAtomValue(nodesAtom);
  const hasForEach = nodes.some(
    (n) => n.data?.config?.actionType === "For Each"
  );
  // end keeperhub code //

  return useMemo(() => {
    const pluginCategories = getActionsByCategory();

    // start custom keeperhub code //
    const systemActions = hasForEach
      ? SYSTEM_ACTIONS
      : SYSTEM_ACTIONS.filter((a) => a.id !== "Collect");
    // end keeperhub code //

    // Build category map including System with both id and label
    const allCategories: Record<
      string,
      Array<{ id: string; label: string }>
    > = {
      System: systemActions,
    };

    for (const [category, actions] of Object.entries(pluginCategories)) {
      // start custom keeperhub code //
      // Deduplicate by slug within each category. When the same action is
      // registered under two integrations (e.g. safe and safe-wallet both
      // contribute "get-pending-transactions"), keep the first occurrence.
      const seen = new Set<string>();
      allCategories[category] = actions
        .filter((a) => {
          if (seen.has(a.slug)) {
            return false;
          }
          seen.add(a.slug);
          return true;
        })
        .map((a) => ({
          id: a.id,
          label: a.label,
        }));
      // end keeperhub code //
    }

    return allCategories;
  }, [hasForEach]);
}

// Get category for an action type (supports both new IDs, labels, and legacy labels)
function getCategoryForAction(actionType: string): string | null {
  // Check system actions first
  if (SYSTEM_ACTION_IDS.includes(actionType)) {
    return "System";
  }

  // Use findActionById which handles legacy labels from plugin registry
  const action = findActionById(actionType);
  if (action?.category) {
    return action.category;
  }

  return null;
}

// Normalize action type to new ID format (handles legacy labels via findActionById)
function normalizeActionType(actionType: string): string {
  // Check system actions first - they use their label as ID
  if (SYSTEM_ACTION_IDS.includes(actionType)) {
    return actionType;
  }

  // Use findActionById which handles legacy labels and returns the proper ID
  const action = findActionById(actionType);
  if (action) {
    return action.id;
  }

  return actionType;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Complex UI logic with many conditional renders
export function ActionConfig({
  config,
  onUpdateConfig,
  disabled,
  isOwner = true,
  // start custom keeperhub code //
  nodeId,
  // end keeperhub code //
}: ActionConfigProps) {
  const actionType = (config?.actionType as string) || "";
  const categories = useCategoryData();
  // start custom keeperhub code //
  // Deduplicate integrations by label for the Service dropdown.
  // When two integrations share a label (e.g. "safe" and "safe-wallet" both
  // labelled "Safe"), keep the one with more actions to avoid Radix Select
  // duplicate-value collisions and present a single unified entry.
  const integrations = useMemo(() => {
    const all = getAllIntegrations();
    const byLabel = new Map<string, (typeof all)[number]>();
    for (const i of all) {
      const existing = byLabel.get(i.label);
      if (!existing || i.actions.length > existing.actions.length) {
        byLabel.set(i.label, i);
      }
    }
    return Array.from(byLabel.values());
  }, []);
  // end keeperhub code //

  const selectedCategory = actionType ? getCategoryForAction(actionType) : null;
  const [category, setCategory] = useState<string>(selectedCategory || "");
  const setIntegrationsVersion = useSetAtom(integrationsVersionAtom);
  const globalIntegrations = useAtomValue(integrationsAtom);
  const { push } = useOverlay();

  // start keeperhub - anonymous check for email action restriction
  const [isAnonymous, setIsAnonymous] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/user")
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) {
          return;
        }
        const anon =
          data.isAnonymous ||
          data.email?.includes("@http://") ||
          data.email?.includes("@https://") ||
          data.email?.startsWith("temp-");
        setIsAnonymous(anon);
      })
      .catch(() => {
        /* intentional noop */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  // end keeperhub

  // AI Gateway managed keys state
  const aiGatewayStatus = useAtomValue(aiGatewayStatusAtom);

  // Sync category state when actionType changes (e.g., when switching nodes)
  useEffect(() => {
    const newCategory = actionType ? getCategoryForAction(actionType) : null;
    setCategory(newCategory || "");
  }, [actionType]);

  const handleCategoryChange = (newCategory: string) => {
    setCategory(newCategory);
    // Auto-select the first action in the new category
    const firstAction = categories[newCategory]?.[0];
    if (firstAction) {
      onUpdateConfig("actionType", firstAction.id);
    }
  };

  const handleActionTypeChange = (value: string) => {
    onUpdateConfig("actionType", value);
  };

  // Adapter for plugin config components that expect (key, value: unknown)
  const handlePluginUpdateConfig = (key: string, value: unknown) => {
    onUpdateConfig(key, String(value));
  };

  // Get dynamic config fields for plugin actions
  const pluginAction = actionType ? findActionById(actionType) : null;

  // Determine the integration type for the current action
  const integrationType: IntegrationType | undefined = useMemo(() => {
    if (!actionType) {
      return;
    }

    // Check system actions first
    if (SYSTEM_ACTION_INTEGRATIONS[actionType]) {
      return SYSTEM_ACTION_INTEGRATIONS[actionType];
    }

    // Check plugin actions - prefer credentialIntegrationType for connection UI
    const action = findActionById(actionType);
    return (action?.credentialIntegrationType ?? action?.integration) as IntegrationType | undefined;
  }, [actionType]);

  // start keeperhub
  // Check if action requires credentials (some like web3 read-only actions don't)
  const requiresCredentials = useMemo(
    () => actionRequiresCredentials(actionType),
    [actionType]
  );
  // end keeperhub

  // Check if AI Gateway managed keys should be offered (user can have multiple for different teams)
  const shouldUseManagedKeys =
    integrationType === "ai-gateway" &&
    aiGatewayStatus?.enabled &&
    aiGatewayStatus?.isVercelUser;

  // Check if there are existing connections for this integration type
  const hasExistingConnections = useMemo(() => {
    // biome-ignore lint/style/useBlockStatements: upstream code
    if (!integrationType) return false;
    return globalIntegrations.some((i) => i.type === integrationType);
  }, [integrationType, globalIntegrations]);

  const handleConsentSuccess = (integrationId: string) => {
    onUpdateConfig("integrationId", integrationId);
    setIntegrationsVersion((v) => v + 1);
  };

  const openConnectionOverlay = () => {
    if (integrationType) {
      push(ConfigureConnectionOverlay, {
        type: integrationType,
        onSuccess: (integrationId: string) => {
          setIntegrationsVersion((v) => v + 1);
          onUpdateConfig("integrationId", integrationId);
        },
      });
    }
  };

  const handleAddSecondaryConnection = () => {
    if (shouldUseManagedKeys) {
      push(AiGatewayConsentOverlay, {
        onConsent: handleConsentSuccess,
        onManualEntry: openConnectionOverlay,
      });
    } else {
      openConnectionOverlay();
    }
  };

  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-2">
          <Label className="ml-1" htmlFor="actionCategory">
            Service
          </Label>
          <Select
            disabled={disabled}
            onValueChange={handleCategoryChange}
            value={category || undefined}
          >
            <SelectTrigger className="w-full" id="actionCategory">
              <SelectValue placeholder="Select category" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="System">
                <div className="flex items-center gap-2">
                  <Settings className="size-4" />
                  <span>System</span>
                </div>
              </SelectItem>
              <SelectSeparator />
              {integrations.map((integration) => (
                <SelectItem key={integration.type} value={integration.label}>
                  <div className="flex items-center gap-2">
                    <IntegrationIcon
                      className="size-4"
                      integration={integration.type}
                    />
                    <span>{integration.label}</span>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label className="ml-1" htmlFor="actionType">
            Action
          </Label>
          <Select
            disabled={disabled || !category}
            onValueChange={handleActionTypeChange}
            value={normalizeActionType(actionType) || undefined}
          >
            <SelectTrigger className="w-full" id="actionType">
              <SelectValue placeholder="Select action" />
            </SelectTrigger>
            <SelectContent>
              {category &&
                categories[category]?.map((action) => (
                  <SelectItem key={action.id} value={action.id}>
                    {action.label}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* start keeperhub - show Connection for plugin actions that require credentials or system actions that use an integration (e.g. Database Query) */}
      {integrationType &&
        isOwner &&
        (requiresCredentials || SYSTEM_ACTION_INTEGRATIONS[actionType]) && (
          <div className="space-y-2">
            <div className="ml-1 flex items-center justify-between">
              <div className="flex items-center gap-1">
                <Label>Connection</Label>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <HelpCircle className="size-3.5 text-muted-foreground" />
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>API key or OAuth credentials for this service</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
              {/* start keeperhub - hide + button for singleConnection integrations */}
              {hasExistingConnections &&
                !getIntegration(integrationType)?.singleConnection && (
                  <Button
                    className="size-6"
                    disabled={disabled}
                    onClick={handleAddSecondaryConnection}
                    size="icon"
                    variant="ghost"
                  >
                    <Plus className="size-4" />
                  </Button>
                )}
              {/* end keeperhub */}
            </div>
            <IntegrationSelector
              disabled={disabled}
              integrationType={integrationType}
              onChange={(id) => onUpdateConfig("integrationId", id)}
              value={(config?.integrationId as string) || ""}
            />
          </div>
        )}
      {/* end keeperhub */}

      {/* System actions - hardcoded config fields */}
      <SystemActionFields
        actionType={(config?.actionType as string) || ""}
        config={config}
        disabled={disabled}
        onUpdateConfig={onUpdateConfig}
      />

      {/* Plugin actions - declarative config fields */}
      {/* start custom keeperhub code // */}
      {pluginAction &&
        !SYSTEM_ACTION_IDS.includes(actionType) &&
        isAnonymous &&
        pluginAction.integration === "sendgrid" && (
          <div className="rounded-lg border bg-muted/50 p-3">
            <p className="text-muted-foreground text-sm">
              Please sign in to configure email actions.
            </p>
          </div>
        )}
      {/* end keeperhub code // */}
      {pluginAction &&
        !SYSTEM_ACTION_IDS.includes(actionType) &&
        !(isAnonymous && pluginAction.integration === "sendgrid") && (
          <ActionConfigRenderer
            config={config}
            disabled={disabled}
            fields={pluginAction.configFields}
            // start custom keeperhub code //
            nodeId={nodeId}
            // end keeperhub code //
            onUpdateConfig={handlePluginUpdateConfig}
          />
        )}
    </>
  );
}
