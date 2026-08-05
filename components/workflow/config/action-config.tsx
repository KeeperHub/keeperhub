"use client";

import { useAtomValue, useSetAtom } from "jotai";
import { Gem, HelpCircle, Plus, Settings } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { FeatureUpgradeDialog } from "@/components/billing/feature-upgrade-dialog";
import { ConfigureConnectionOverlay } from "@/components/overlays/add-connection-overlay";
import { useOverlay } from "@/components/overlays/overlay-provider";
import { Button } from "@/components/ui/button";
import { FailOnErrorSwitchField } from "@/components/workflow/config/fail-on-error-switch-field";
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
import { SqlTemplateEditor } from "@/components/ui/sql-template-editor";
import { TemplateCodeEditor } from "@/components/ui/template-code-editor";
import { actionRequiresCredentials } from "@/lib/integration-helpers";
import { ConditionQueryBuilder } from "@/components/workflow/condition-query-builder";
import type { ConditionGroup } from "@/lib/workflow/nodes/condition/builder-types";
import {
  DEFAULT_HTTP_METHOD,
  HTTP_METHODS,
} from "@/lib/workflow/nodes/http-request/constants";
import {
  createEmptyGroup,
  expressionToConditionGroup,
  visualConditionToExpression,
} from "@/lib/workflow/nodes/condition/builder-utils";
import { resolveConditionExpression } from "@/lib/workflow/nodes/condition/resolver";
import { validateConditionExpressionUI } from "@/lib/workflow/nodes/condition/validator";
import { useFeatures } from "@/hooks/use-features";
import type { FeatureDefinition } from "@/lib/features";
import { resolveActionFeature } from "@/lib/features";
import {
  integrationsAtom,
  integrationsVersionAtom,
} from "@/lib/integrations-store";
import type { IntegrationType } from "@/lib/types/integration";
import {
  ARRAY_SOURCE_RE,
  extractObjectPaths,
  resolveArraySourceElement,
  traverseDotPath,
} from "@/lib/workflow/nodes/for-each/utils";
import {
  executionLogsAtom,
  lastExecutionLogsAtom,
  nodesAtom,
} from "@/lib/workflow/store";
import {
  findActionById,
  getActionsByCategory,
  getAllIntegrations,
  getIntegration,
} from "@/plugins/registry";
import { ActionConfigRenderer } from "./action-config-renderer";
import { SchemaBuilder, type SchemaField } from "./schema-builder";
import { Web3ConnectionSelect } from "./web3-connection-select";

type ConfigValue = string | boolean | Record<string, unknown> | undefined;

type ActionConfigProps = {
  config: Record<string, unknown>;
  onUpdateConfig: (key: string, value: ConfigValue) => void;
  disabled: boolean;
  isOwner?: boolean;
  nodeId?: string;
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
      <div className="space-y-2">
        <Label htmlFor="connectTimeout">Connection timeout (seconds)</Label>
        <Input
          disabled={disabled}
          id="connectTimeout"
          max={60}
          min={1}
          onChange={(e) => {
            const raw = e.target.value.replace(/[^0-9]/g, "");
            onUpdateConfig("connectTimeout", raw);
          }}
          placeholder="30"
          type="number"
          value={(config?.connectTimeout as string) || ""}
        />
        <p className="text-muted-foreground text-xs">
          How long to wait to connect. Default 30 seconds, max 60. Raise this
          for serverless databases that scale to zero and need time to wake.
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="retries">Connection retries</Label>
        <Input
          disabled={disabled}
          id="retries"
          max={3}
          min={0}
          onChange={(e) => {
            const raw = e.target.value.replace(/[^0-9]/g, "");
            onUpdateConfig("retries", raw);
          }}
          placeholder="1"
          type="number"
          value={(config?.retries as string) || ""}
        />
        <p className="text-muted-foreground text-xs">
          Retries only when the database is unreachable at connect time (safe
          for cold starts). It never re-runs a query that already started.
          Default 1, max 3.
        </p>
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
  onUpdateConfig: (key: string, value: ConfigValue) => void;
  disabled: boolean;
}) {
  return (
    <>
      <div className="space-y-2">
        <Label htmlFor="httpMethod">HTTP Method</Label>
        <Select
          disabled={disabled}
          onValueChange={(value) => onUpdateConfig("httpMethod", value)}
          value={(config?.httpMethod as string) || DEFAULT_HTTP_METHOD}
        >
          <SelectTrigger className="w-full" id="httpMethod">
            <SelectValue placeholder="Select method" />
          </SelectTrigger>
          <SelectContent>
            {HTTP_METHODS.map((method) => (
              <SelectItem key={method} value={method}>
                {method}
              </SelectItem>
            ))}
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
        <TemplateCodeEditor
          disabled={disabled}
          height="100px"
          language="json"
          onChange={(value) => onUpdateConfig("httpHeaders", value || "{}")}
          value={(config?.httpHeaders as string) || "{}"}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="httpBody">Body (JSON)</Label>
        <div
          className={config?.httpMethod === "GET" ? "opacity-50" : ""}
        >
          <TemplateCodeEditor
            disabled={config?.httpMethod === "GET" || disabled}
            height="120px"
            language="json"
            onChange={(value) => onUpdateConfig("httpBody", value || "{}")}
            value={(config?.httpBody as string) || "{}"}
          />
        </div>
        {config?.httpMethod === "GET" && (
          <p className="text-muted-foreground text-xs">
            Body is disabled for GET requests
          </p>
        )}
      </div>
      <div className="space-y-2">
        <Label htmlFor="timeout">Timeout (seconds)</Label>
        <Input
          disabled={disabled}
          id="timeout"
          max={30}
          min={1}
          onChange={(e) => {
            const raw = e.target.value.replace(/[^0-9]/g, "");
            onUpdateConfig("timeout", raw);
          }}
          placeholder="5"
          type="number"
          value={(config?.timeout as string) || ""}
        />
        <p className="text-muted-foreground text-xs">
          How long to wait for a response. Default 5 seconds, max 30.
        </p>
      </div>
      <FailOnErrorSwitchField
        description="When off, a non-2xx response or timeout passes a soft error to the next node instead of failing the run."
        disabled={disabled}
        id="failOnError"
        label="Fail workflow on error"
        onChange={(checked) => onUpdateConfig("failOnError", checked)}
        value={config?.failOnError}
      />
    </>
  );
}

// Condition fields component with visual builder + expression mode toggle
function ConditionFields({
  config,
  onUpdateConfig,
  disabled,
}: {
  config: Record<string, unknown>;
  onUpdateConfig: (key: string, value: ConfigValue) => void;
  disabled: boolean;
}) {
  const conditionValue =
    resolveConditionExpression(config ?? {}) ?? "";
  const existingConditionConfig = config?.conditionConfig as
    | { group: ConditionGroup }
    | undefined;

  // Parse expression into visual form (memoized, computed once).
  // Also derives the initial mode to avoid parsing the expression twice.
  // Re-parses when the stored visual group's expression doesn't match the
  // actual condition expression (e.g. after operator support was extended).
  const { parsedGroup, initialMode } = useMemo(() => {
    if (!conditionValue) {
      return { parsedGroup: null, initialMode: "visual" as const };
    }
    if (existingConditionConfig) {
      const storedExpression = visualConditionToExpression(
        existingConditionConfig.group
      );
      if (storedExpression === conditionValue) {
        return { parsedGroup: null, initialMode: "visual" as const };
      }
    }
    const parsed = expressionToConditionGroup(conditionValue);
    return {
      parsedGroup: parsed,
      initialMode: parsed !== null ? ("visual" as const) : ("expression" as const),
    };
  }, [conditionValue, existingConditionConfig]);

  // Persist the parsed group to config so it's saved with the workflow.
  // Track identity via conditionValue to reset when switching between nodes.
  const persistedForExpression = useRef<string | null>(null);
  useEffect(() => {
    if (parsedGroup && persistedForExpression.current !== conditionValue) {
      onUpdateConfig("conditionConfig", { group: parsedGroup });
      persistedForExpression.current = conditionValue;
    }
  }, [parsedGroup, conditionValue, onUpdateConfig]);

  const [mode, setMode] = useState<"visual" | "expression">(initialMode);

  const [validationError, setValidationError] = useState<string | null>(null);

  // Debounced validation for expression mode
  useEffect(() => {
    if (mode !== "expression" || !conditionValue.trim()) {
      setValidationError(null);
      return;
    }

    const timeoutId = setTimeout(() => {
      const result = validateConditionExpressionUI(conditionValue);
      setValidationError(result.valid ? null : result.error);
    }, 400);

    return () => clearTimeout(timeoutId);
  }, [conditionValue, mode]);

  const handleVisualChange = (group: ConditionGroup): void => {
    const expression = visualConditionToExpression(group);
    onUpdateConfig("conditionConfig", { group });
    onUpdateConfig("condition", expression);
  };

  const handleModeSwitch = (newMode: "visual" | "expression"): void => {
    if (newMode === "expression" && existingConditionConfig) {
      // Clear visual config so the raw expression takes precedence on reload
      onUpdateConfig("conditionConfig", undefined);
    }
    setMode(newMode);
  };

  const emptyGroup = useMemo(() => createEmptyGroup(), []);
  const currentGroup =
    existingConditionConfig?.group ?? parsedGroup ?? emptyGroup;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label>Condition</Label>
        <div className="flex gap-1 rounded-md border p-0.5">
          <button
            className={`rounded px-2 py-0.5 text-xs transition-colors ${
              mode === "visual"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
            disabled={disabled}
            onClick={() => handleModeSwitch("visual")}
            type="button"
          >
            Visual
          </button>
          <button
            className={`rounded px-2 py-0.5 text-xs transition-colors ${
              mode === "expression"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
            disabled={disabled}
            onClick={() => handleModeSwitch("expression")}
            type="button"
          >
            Expression
          </button>
        </div>
      </div>

      {mode === "visual" ? (
        <div className="space-y-3">
          <ConditionQueryBuilder
            disabled={disabled}
            group={currentGroup}
            onChange={handleVisualChange}
          />
          {conditionValue.trim() && (
            <div className="space-y-1">
              <Label className="text-muted-foreground text-xs">
                Generated expression
              </Label>
              <pre className="bg-muted rounded-md p-2 text-xs break-all whitespace-pre-wrap">
                {conditionValue}
              </pre>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <TemplateBadgeInput
            disabled={disabled}
            id="condition"
            onChange={(value) => onUpdateConfig("condition", value)}
            placeholder="e.g., 5 > 3, status === 200, {{PreviousNode.value}} > 100"
            value={conditionValue}
          />
          {validationError && (
            <p className="text-xs text-yellow-600">{validationError}</p>
          )}
          <p className="text-muted-foreground text-xs">
            Enter a JavaScript expression that evaluates to true or false. Use @
            to reference previous node outputs.
          </p>
        </div>
      )}
    </div>
  );
}
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
  const itemFields = useArrayItemFields(
    config?.arraySource as string | undefined
  );
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
          a single array. The Collect node marks the end of the loop body;
          nodes connected after Collect run once with the aggregated results.
        </p>
      </div>
      <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
        <p className="font-medium text-sm">Available outputs</p>
        <ul className="list-disc space-y-1 pl-4 text-muted-foreground text-sm">
          <li>
            <code className="text-xs">Collect.results</code>: Array of
            outputs, one entry per iteration (from the last body node before
            Collect)
          </li>
          <li>
            <code className="text-xs">Collect.count</code>: Number of
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

// System action fields wrapper - extracts conditional rendering to reduce complexity
function SystemActionFields({
  actionType,
  config,
  onUpdateConfig,
  disabled,
}: {
  actionType: string;
  config: Record<string, unknown>;
  onUpdateConfig: (key: string, value: ConfigValue) => void;
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
    default:
      return null;
  }
}

// System actions that don't have plugins
const SYSTEM_ACTIONS: Array<{ id: string; label: string }> = [
  { id: "HTTP Request", label: "HTTP Request" },
  { id: "Database Query", label: "Database Query" },
  { id: "Condition", label: "Condition" },
  { id: "For Each", label: "For Each" },
  { id: "Collect", label: "Collect" },
];

const SYSTEM_ACTION_IDS = SYSTEM_ACTIONS.map((a) => a.id);

// System actions that need integrations (not in plugin registry)
const SYSTEM_ACTION_INTEGRATIONS: Record<string, IntegrationType> = {
  "Database Query": "database",
};

// Build category mapping dynamically from plugins + System
function useCategoryData() {
  const nodes = useAtomValue(nodesAtom);
  const hasForEach = nodes.some(
    (n) => n.data?.config?.actionType === "For Each"
  );

  return useMemo(() => {
    const pluginCategories = getActionsByCategory();

    const systemActions = hasForEach
      ? SYSTEM_ACTIONS
      : SYSTEM_ACTIONS.filter((a) => a.id !== "Collect");

    // Build category map including System with both id and label
    const allCategories: Record<
      string,
      Array<{ id: string; label: string }>
    > = {
      System: systemActions,
    };

    for (const [category, actions] of Object.entries(pluginCategories)) {
      // Deduplicate by slug within each category. When the same action is
      // registered under two integrations, keep the first occurrence.
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
  nodeId,
}: ActionConfigProps) {
  const actionType = (config?.actionType as string) || "";
  const categories = useCategoryData();
  // Deduplicate integrations by label for the Service dropdown.
  // When two integrations share a label, keep the one with more actions
  // to avoid Radix Select duplicate-value collisions.
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

  const selectedCategory = actionType ? getCategoryForAction(actionType) : null;
  const [category, setCategory] = useState<string>(selectedCategory || "");
  const setIntegrationsVersion = useSetAtom(integrationsVersionAtom);
  const globalIntegrations = useAtomValue(integrationsAtom);
  const { push } = useOverlay();

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

  // Sync category state when actionType changes (e.g., when switching nodes)
  useEffect(() => {
    const newCategory = actionType ? getCategoryForAction(actionType) : null;
    setCategory(newCategory || "");
  }, [actionType]);

  const { snapshot: featureSnapshot } = useFeatures();
  const [upgradeFeature, setUpgradeFeature] = useState<FeatureDefinition | null>(
    null
  );

  const isActionLocked = (actionId: string): FeatureDefinition | null => {
    const feature = resolveActionFeature(actionId);
    if (!feature) {
      return null;
    }
    const enabled =
      featureSnapshot?.enabledFeatureIds.includes(feature.id) ?? false;
    return enabled ? null : feature;
  };

  const handleCategoryChange = (newCategory: string): void => {
    setCategory(newCategory);
    const firstAvailable = categories[newCategory]?.find(
      (a) => isActionLocked(a.id) === null
    );
    if (firstAvailable) {
      onUpdateConfig("actionType", firstAvailable.id);
    }
  };

  const handleActionTypeChange = (value: string): void => {
    const lockedFeature = isActionLocked(value);
    if (lockedFeature) {
      setUpgradeFeature(lockedFeature);
      return;
    }
    onUpdateConfig("actionType", value);
  };

  // Adapter for plugin config components that expect (key, value: unknown).
  // KEEP-137: do NOT coerce to string -- booleans (e.g. usePrivateMempool)
  // must remain booleans so downstream truthy checks work and the ChainSelect
  // private-mempool variant resolves correctly. String() turns `false` into
  // the truthy string "false", which both breaks the UI (Select stuck on the
  // Flashbots variant) and the runtime (private-mempool routing stays on).
  const handlePluginUpdateConfig = (key: string, value: unknown): void => {
    if (
      typeof value === "string" ||
      typeof value === "boolean" ||
      value === undefined ||
      (typeof value === "object" && value !== null && !Array.isArray(value))
    ) {
      onUpdateConfig(key, value as ConfigValue);
      return;
    }
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

  // Check if action requires credentials (some like web3 read-only actions don't)
  const requiresCredentials = useMemo(
    () => actionRequiresCredentials(actionType),
    [actionType]
  );

  // Check if there are existing connections for this integration type
  const hasExistingConnections = useMemo(() => {
    if (!integrationType) {
      return false;
    }
    return globalIntegrations.some((i) => i.type === integrationType);
  }, [integrationType, globalIntegrations]);

  const handleAddSecondaryConnection = () => {
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
                categories[category]?.map((action) => {
                  const lockedFeature = isActionLocked(action.id);
                  return (
                    <SelectItem
                      data-locked={lockedFeature ? "true" : undefined}
                      key={action.id}
                      value={action.id}
                    >
                      <span className="flex items-center gap-1.5">
                        {lockedFeature && (
                          <Gem className="size-3 text-[var(--color-text-accent)]" />
                        )}
                        <span
                          className={lockedFeature ? "opacity-70" : undefined}
                        >
                          {action.label}
                        </span>
                      </span>
                    </SelectItem>
                  );
                })}
            </SelectContent>
          </Select>
          {pluginAction?.docUrl && (
            <a
              className="ml-1 inline-flex items-center text-muted-foreground text-xs hover:text-primary"
              href={pluginAction.docUrl}
              rel="noopener noreferrer"
              target="_blank"
            >
              Docs &#x2197;
            </a>
          )}
        </div>
      </div>

      {integrationType &&
        isOwner &&
        (requiresCredentials || SYSTEM_ACTION_INTEGRATIONS[actionType]) &&
        (isAnonymous && requiresCredentials ? (
          <div className="rounded-lg border bg-muted/50 p-3">
            <p className="text-muted-foreground text-sm">
              Please sign in to add a connection.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="ml-1 flex items-center justify-between">
              <div className="flex items-center gap-1">
                <Label>
                  {integrationType === "web3" ? "Web3 Connection" : "Connection"}
                </Label>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <HelpCircle className="size-3.5 text-muted-foreground" />
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>
                        {integrationType === "web3"
                          ? "Which wallet is the sender (msg.sender) for this transaction. Your EOA always signs the outer tx and pays gas."
                          : "API key or OAuth credentials for this service"}
                      </p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
              {integrationType !== "web3" &&
                hasExistingConnections &&
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
            </div>
            {integrationType === "web3" ? (
              <Web3ConnectionSelect
                disabled={disabled}
                network={(config?.network as string) || undefined}
                onChange={(val) => onUpdateConfig("web3Connection", val)}
                value={(config?.web3Connection as string) || undefined}
              />
            ) : (
              <IntegrationSelector
                disabled={disabled}
                integrationType={integrationType}
                onChange={(id) => onUpdateConfig("integrationId", id)}
                value={(config?.integrationId as string) || ""}
              />
            )}
          </div>
        ))}

      {/* System actions - hardcoded config fields */}
      <SystemActionFields
        actionType={(config?.actionType as string) || ""}
        config={config}
        disabled={disabled}
        onUpdateConfig={onUpdateConfig}
      />

      {/* Plugin actions - declarative config fields */}
      {pluginAction &&
        !SYSTEM_ACTION_IDS.includes(actionType) &&
        !(isAnonymous && requiresCredentials) && (
          <ActionConfigRenderer
            config={config}
            disabled={disabled}
            fields={pluginAction.configFields}
            nodeId={nodeId}
            onUpdateConfig={handlePluginUpdateConfig}
          />
        )}
      <FeatureUpgradeDialog
        feature={upgradeFeature}
        onOpenChange={(open) => {
          if (!open) {
            setUpgradeFeature(null);
          }
        }}
        open={upgradeFeature !== null}
      />
    </>
  );
}
