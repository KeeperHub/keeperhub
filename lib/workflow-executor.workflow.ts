/**
 * Workflow-based executor using "use workflow" and "use step" directives
 * This executor captures step executions through the workflow SDK for better observability
 */

import {
  BUILTIN_NODE_ID,
  BUILTIN_NODE_LABEL,
  getBuiltinVariables,
} from "@/lib/builtin-variables";
import {
  ErrorCategory,
  logSystemError,
  logUserError,
} from "@/lib/logging";
import { enterWorkflowErrorContext } from "@/lib/workflow-error-context";
import { getMetricsCollector } from "@/lib/metrics";
import { LabelKeys, MetricNames } from "@/lib/metrics/types";
import {
  decrementConcurrentExecutions,
  incrementConcurrentExecutions,
} from "@/lib/metrics/instrumentation/saturation";
import {
  detectTriggerType,
  recordWorkflowComplete,
} from "@/lib/metrics/instrumentation/workflow";
import { clearExecution } from "@/lib/step-success-tracker";
import { ARRAY_SOURCE_RE } from "@/lib/for-each-utils";
import {
  buildEdgesBySourceHandle,
  type EdgesBySourceHandle,
} from "@/lib/edge-handle-utils";
import {
  collectAllSkippedTargets,
  collectSkippedTargets,
  type ConditionDecision,
} from "@/lib/skipped-branch-utils";
import {
  buildEdgesBySource,
  buildEdgesByTarget,
  getReadyDownstreamIds,
  propagateConvergenceSkips,
  signalConvergenceArrival,
} from "@/lib/convergence-barrier";
import { resolveConditionExpression } from "@/lib/condition-resolver";
import {
  applyBigIntConversion,
  needsBigIntMode,
} from "@/lib/bigint-condition-utils";
import {
  preValidateConditionExpression,
  validateConditionExpression,
} from "@/lib/condition-validator";
import {
  getActionLabel,
  getStepImporter,
  type StepImporter,
} from "./step-registry";
import { LEGACY_ACTION_MAPPINGS } from "@/plugins/legacy-mappings";
import type { StepContext } from "./steps/step-handler";
import { triggerStep } from "./steps/trigger";
import { deserializeEventTriggerData, getErrorMessageAsync } from "./utils";
import type { WorkflowEdge, WorkflowNode } from "./workflow-store";

// System actions that don't have plugins - maps to module import functions
const SYSTEM_ACTIONS: Record<string, StepImporter> = {
  "Database Query": {
    // biome-ignore lint/suspicious/noExplicitAny: Dynamic module import
    importer: () => import("./steps/database-query") as Promise<any>,
    stepFunction: "databaseQueryStep",
  },
  "HTTP Request": {
    // biome-ignore lint/suspicious/noExplicitAny: Dynamic module import
    importer: () => import("./steps/http-request") as Promise<any>,
    stepFunction: "httpRequestStep",
  },
  Condition: {
    // biome-ignore lint/suspicious/noExplicitAny: Dynamic module import
    importer: () => import("./steps/condition") as Promise<any>,
    stepFunction: "conditionStep",
  },
  "For Each": {
    importer: () =>
      // biome-ignore lint/suspicious/noExplicitAny: Dynamic module import matches existing pattern
      import("@/lib/steps/for-each") as Promise<any>,
    stepFunction: "forEachStep",
  },
  Collect: {
    importer: () =>
      // biome-ignore lint/suspicious/noExplicitAny: Dynamic module import matches existing pattern
      import("@/lib/steps/collect") as Promise<any>,
    stepFunction: "collectStep",
  },
};

type ExecutionResult = {
  success: boolean;
  data?: unknown;
  error?: string;
};

type NodeOutputs = Record<string, { label: string; data: unknown }>;

/** Matches path segment like "carts[0]" for array index access (same as template.ts) */
const ARRAY_ACCESS_PATTERN = /^([^[]+)\[(\d+)\]$/;

export type WorkflowExecutionInput = {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  triggerInput?: Record<string, unknown>;
  executionId?: string;
  workflowId?: string; // Used by steps to fetch credentials
  organizationId?: string;
  organizationName?: string; // Used for log filtering by org name
  // Identifiers attached to every workflow error log line
  organizationSlug?: string;
  ownerId?: string;
};

/**
 * Helper to replace template variables in conditions
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: KEEP-1284 validation requires checking multiple error conditions
function replaceTemplateVariable(
  _match: string,
  nodeId: string,
  rest: string,
  outputs: NodeOutputs,
  evalContext: Record<string, unknown>,
  varCounter: { value: number },
  nodeMap?: ReadonlyMap<string, unknown>,
  executionResults?: Record<string, ExecutionResult>
): string {
  const sanitizedNodeId = nodeId.replace(/[^a-zA-Z0-9]/g, "_");
  const output = outputs[sanitizedNodeId];

  // KEEP-1284: Throw error when referenced node output doesn't exist
  if (!output) {
    // Dead-branch grace: if the node exists in the workflow graph but was never
    // executed (it sits on a branch that a condition did not take), return
    // undefined instead of throwing so the condition evaluates gracefully.
    if (nodeMap?.has(nodeId) && executionResults && !(nodeId in executionResults)) {
      const varName = `__v${varCounter.value}`;
      varCounter.value += 1;
      evalContext[varName] = undefined;
      return varName;
    }
    throw new Error(
      `Condition references node "${nodeId}" but no output was found. The referenced node may not have executed or produced output.`
    );
  }

  const dotIndex = rest.indexOf(".");
  let value: unknown;

  if (dotIndex === -1) {
    value = output.data;
  } else if (output.data === null || output.data === undefined) {
    // KEEP-1284: Throw error when node data is null/undefined
    throw new Error(
      `Condition references "${rest}" but the node output data is ${output.data === null ? "null" : "undefined"}. Ensure the referenced node produces valid output.`
    );
  } else {
    const fieldPath = rest.substring(dotIndex + 1);
    const fields = fieldPath.split(".");
    // biome-ignore lint/suspicious/noExplicitAny: Dynamic data traversal
    let current: any = output.data;

    for (const segment of fields) {
      if (current === null || current === undefined) {
        throw new Error(
          `Condition references field "${fieldPath}" but it could not be resolved. Check that the field path is correct.`
        );
      }
      if (typeof current !== "object") {
        throw new Error(
          `Condition references field "${fieldPath}" but it could not be resolved. Check that the field path is correct.`
        );
      }

      const arrayMatch = segment.match(ARRAY_ACCESS_PATTERN);
      if (arrayMatch) {
        const [, key, indexStr] = arrayMatch;
        const index = Number.parseInt(indexStr, 10);
        if (!(key in current)) {
          throw new Error(
            `Condition references field "${fieldPath}" but "${key}" does not exist on the data. Available fields: ${Object.keys(current).join(", ") || "(none)"}`
          );
        }
        const arr = current[key];
        if (!Array.isArray(arr)) {
          throw new Error(
            `Condition references field "${fieldPath}" but "${key}" is not an array. Cannot access [${index}].`
          );
        }
        if (index < 0 || index >= arr.length) {
          throw new Error(
            `Condition references field "${fieldPath}" but "${segment}" is out of range (array length ${arr.length}). Use index 0 to ${arr.length - 1}.`
          );
        }
        current = arr[index];
      } else {
        if (!(segment in current)) {
          throw new Error(
            `Condition references field "${fieldPath}" but "${segment}" does not exist on the data. Available fields: ${Object.keys(current).join(", ") || "(none)"}`
          );
        }
        current = current[segment];
      }
    }
    value = current;
  }

  const varName = `__v${varCounter.value}`;
  varCounter.value += 1;
  evalContext[varName] = value;
  return varName;
}

type ConditionEvalResult = {
  result: boolean;
  resolvedValues: Record<string, unknown>;
};

/**
 * Evaluate condition expression with template variable replacement
 * Uses Function constructor to evaluate user-defined conditions dynamically
 *
 * Security: Expressions are validated before evaluation to prevent code injection.
 * Only comparison operators, logical operators, and whitelisted methods are allowed.
 */
// Exported for testing - KEEP-1284
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: KEEP-1284 validation requires comprehensive error checking
export function evaluateConditionExpression(
  conditionExpression: unknown,
  outputs: NodeOutputs,
  nodeMap?: ReadonlyMap<string, unknown>,
  executionResults?: Record<string, ExecutionResult>
): ConditionEvalResult {
  console.log("[Condition] Original expression:", conditionExpression);

  // KEEP-1284: Throw error when condition is not configured
  if (conditionExpression === undefined || conditionExpression === null) {
    throw new Error(
      "Condition node has no expression configured. Please add a condition expression."
    );
  }

  if (typeof conditionExpression === "boolean") {
    return { result: conditionExpression, resolvedValues: {} };
  }

  if (typeof conditionExpression === "string") {
    // Pre-validate the expression before any processing
    // KEEP-1284: Throw error when condition is empty/invalid instead of silently returning false
    const preValidation = preValidateConditionExpression(conditionExpression);
    if (!preValidation.valid) {
      throw new Error(
        `Condition expression is invalid: ${preValidation.error}. Expression: "${conditionExpression}"`
      );
    }

    try {
      let evalContext: Record<string, unknown> = {};
      const resolvedValues: Record<string, unknown> = {};
      let transformedExpression = conditionExpression;
      const templatePattern = /\{\{@([^:]+):([^}]+)\}\}/g;
      const varCounter = { value: 0 };

      transformedExpression = transformedExpression.replace(
        templatePattern,
        (match, nodeId, rest) => {
          const varName = replaceTemplateVariable(
            match,
            nodeId,
            rest,
            outputs,
            evalContext,
            varCounter,
            nodeMap,
            executionResults
          );
          // Store the resolved value with a readable key (the display text from the template)
          resolvedValues[rest] = evalContext[varName];
          return varName;
        }
      );

      // Validate the transformed expression before evaluation
      // KEEP-1284: Throw error when validation fails instead of silently returning false
      const validation = validateConditionExpression(transformedExpression);
      if (!validation.valid) {
        throw new Error(
          `Condition expression validation failed: ${validation.error}. Original: "${conditionExpression}"`
        );
      }

      // BigInt-safe conversion for large Web3 values (e.g. token balances in wei)
      if (needsBigIntMode(transformedExpression, evalContext)) {
        const converted = applyBigIntConversion(
          transformedExpression,
          evalContext
        );
        transformedExpression = converted.expression;
        evalContext = converted.evalContext;
      }

      const varNames = Object.keys(evalContext);
      const varValues = Object.values(evalContext);

      // Safe to evaluate - expression has been validated
      // Only contains: variables (__v0, __v1), operators, literals, and whitelisted methods
      const evalFunc = new Function(
        ...varNames,
        `return (${transformedExpression});`
      );
      const result = evalFunc(...varValues);
      return { result: Boolean(result), resolvedValues };
    } catch (error) {
      // KEEP-1284: Re-throw errors about missing data - these should not be silently swallowed
      if (
        error instanceof Error &&
        error.message.includes("Condition references")
      ) {
        throw error;
      }
      // Other errors (syntax errors, etc.) are user input errors - log as WARN not ERROR
      logUserError(
        ErrorCategory.VALIDATION,
        "[Condition] Failed to evaluate user expression:",
        error,
        {
          expression: conditionExpression,
        }
      );
      throw new Error(
        `Failed to evaluate condition expression: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // KEEP-1284: Throw error for unexpected expression types (number, object, etc.)
  throw new Error(
    `Condition expression must be a string or boolean, got ${typeof conditionExpression}`
  );
}

/**
 * Execute a single action step with logging via stepHandler
 * IMPORTANT: Steps receive only the integration ID as a reference to fetch credentials.
 * This prevents credentials from being logged in Vercel's workflow observability.
 */
async function executeActionStep(input: {
  actionType: string;
  config: Record<string, unknown>;
  outputs: NodeOutputs;
  context: StepContext;
  nodeMap?: ReadonlyMap<string, unknown>;
  executionResults?: Record<string, ExecutionResult>;
}) {
  const { actionType, config, outputs, context } = input;

  // Build step input WITHOUT credentials, but WITH integrationId reference and logging context
  const stepInput: Record<string, unknown> = {
    ...config,
    _actionType: actionType,
    _context: context,
  };

  // Special handling for Condition action - needs template evaluation
  if (actionType === "Condition") {
    const systemAction = SYSTEM_ACTIONS.Condition;
    const module = await systemAction.importer();
    const originalExpression =
      resolveConditionExpression(stepInput) ?? stepInput.condition;

    // KEEP-1284: Catch evaluation errors and pass to step so it gets logged
    let evaluatedCondition = false;
    let resolvedValues: Record<string, unknown> = {};
    let evaluationError: string | undefined;

    try {
      const result = evaluateConditionExpression(
        originalExpression,
        outputs,
        input.nodeMap,
        input.executionResults
      );
      evaluatedCondition = result.result;
      resolvedValues = result.resolvedValues;
    } catch (error) {
      evaluationError = error instanceof Error ? error.message : String(error);
    }

    console.log("[Condition] Final result:", evaluatedCondition);

    return await module[systemAction.stepFunction]({
      condition: evaluatedCondition,
      // Include original expression only when evaluation succeeded (avoid raw template in UI on failure)
      expression:
        !evaluationError && typeof originalExpression === "string"
          ? originalExpression
          : undefined,
      values:
        Object.keys(resolvedValues).length > 0 ? resolvedValues : undefined,
      _evaluationError: evaluationError,
      _context: context,
    });
  }

  // Check system actions first (Database Query, HTTP Request)
  const systemAction = SYSTEM_ACTIONS[actionType];
  if (systemAction) {
    const module = await systemAction.importer();
    const stepFunction = module[systemAction.stepFunction];
    return await stepFunction(stepInput);
  }

  // Look up plugin action from the generated step registry
  let stepImporter = getStepImporter(actionType);

  // Fallback: check legacy action mappings (e.g. "safe-wallet/get-owners" -> "safe/get-owners")
  if (!stepImporter) {
    const mapped = LEGACY_ACTION_MAPPINGS[actionType];
    if (mapped) {
      stepImporter = getStepImporter(mapped);
    }
  }

  if (stepImporter) {
    const module = await stepImporter.importer();
    const stepFunction = module[stepImporter.stepFunction];
    if (stepFunction) {
      return await stepFunction(stepInput);
    }

    return {
      success: false,
      error: `Step function "${stepImporter.stepFunction}" not found in module for action "${actionType}". Check that the plugin exports the correct function name.`,
    };
  }

  // Fallback for unknown action types
  return {
    success: false,
    error: `Unknown action type: "${actionType}". This action is not registered in the plugin system. Available system actions: ${Object.keys(SYSTEM_ACTIONS).join(", ")}.`,
  };
}

/**
 * Resolve a field path (e.g. "data.recipes[0].tags[0]") into a value.
 * Supports bracket notation for array indices.
 */
function resolveConfigFieldPath(data: unknown, fieldPath: string): unknown {
  if (data === null || data === undefined) {
    return;
  }
  const parts = fieldPath.split(".");
  let current: unknown = data;
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }
    const arrayMatch = trimmed.match(ARRAY_ACCESS_PATTERN);
    if (arrayMatch) {
      const [, key, indexStr] = arrayMatch;
      const obj = current as Record<string, unknown>;
      const arr = obj?.[key];
      if (!Array.isArray(arr)) {
        return;
      }
      current = arr[Number.parseInt(indexStr, 10)];
    } else {
      current = (current as Record<string, unknown>)?.[trimmed];
    }
    if (current === undefined || current === null) {
      return;
    }
  }
  return current;
}

function formatConfigValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return JSON.stringify(value);
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

/** True when output has shape { data: object } (e.g. HTTP step result). */
function hasNestedDataShape(
  data: unknown
): data is Record<string, unknown> & { data: object } {
  return (
    typeof data === "object" &&
    data !== null &&
    "data" in data &&
    typeof (data as Record<string, unknown>).data === "object"
  );
}

/**
 * Resolve from output.data, or from output.data.data when step wraps body in .data (e.g. HTTP).
 */
function resolveFromOutputData(data: unknown, fieldPath: string): unknown {
  const fromTop = fieldPath ? resolveConfigFieldPath(data, fieldPath) : data;
  if (fromTop !== undefined && fromTop !== null) {
    return fromTop;
  }
  if (hasNestedDataShape(data)) {
    const inner = data.data;
    return fieldPath ? resolveConfigFieldPath(inner, fieldPath) : inner;
  }
  return;
}

function replaceConfigTemplate(
  match: string,
  nodeId: string,
  rest: string,
  outputs: NodeOutputs
): string {
  const trimmedNodeId = nodeId.trim();
  const sanitizedNodeId = trimmedNodeId.replace(/[^a-zA-Z0-9]/g, "_");
  const output = outputs[sanitizedNodeId] ?? outputs[trimmedNodeId];
  const fieldPath = rest.includes(".")
    ? rest.substring(rest.indexOf(".") + 1).trim()
    : "";

  console.log("[Template] Resolving:", {
    template: match,
    nodeId: trimmedNodeId,
    sanitizedNodeId,
    fieldPath: fieldPath || "(whole output)",
    outputKeys: Object.keys(outputs),
    foundOutput: !!output,
  });

  if (!output) {
    console.log("[Template] No output for node, returning empty string");
    return "";
  }
  const data = output.data;
  if (data === null || data === undefined) {
    console.log(
      "[Template] Output data is null/undefined, returning empty string"
    );
    return "";
  }

  const dataKeys =
    typeof data === "object" && data !== null
      ? Object.keys(data as Record<string, unknown>)
      : [];
  console.log("[Template] Output data top-level keys:", dataKeys);

  const resolved = resolveFromOutputData(data, fieldPath);
  if (resolved === undefined || resolved === null) {
    if (hasNestedDataShape(data)) {
      const innerKeys = Object.keys(data.data as Record<string, unknown>);
      console.log("[Template] Trying inner output.data, keys:", innerKeys);
    }
    console.log(
      "[Template] Path not found, returning empty string. fieldPath:",
      fieldPath
    );
    return "";
  }

  console.log(
    "[Template] Resolved, type:",
    typeof resolved,
    Array.isArray(resolved) ? "array" : ""
  );
  return formatConfigValue(resolved);
}

/**
 * Process template variables in config.
 * Recurses into nested objects; supports array paths like data.recipes[0].
 */
function processTemplates(
  config: Record<string, unknown>,
  outputs: NodeOutputs
): Record<string, unknown> {
  const processed: Record<string, unknown> = {};
  const storedPattern = /\{\{@([^:]+):([^}]+)\}\}/g;
  // Fallback: resolve display-format templates {{Label.field}} that were not
  // converted to stored format by the editor (mirrors extractTemplateParameters).
  const displayPattern = /\{\{([^@}][^}]*)\}\}/g;

  for (const [key, value] of Object.entries(config)) {
    if (typeof value === "string") {
      let result = value.replace(storedPattern, (m, nodeId, rest) =>
        replaceConfigTemplate(m, nodeId, rest, outputs)
      );
      result = result.replace(displayPattern, (full, displayRef) => {
        const resolved = resolveDisplayTemplate(displayRef, outputs);
        if (resolved === null || resolved === undefined) {
          return full;
        }
        return formatConfigValue(resolved);
      });
      processed[key] = result;
    } else if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value)
    ) {
      processed[key] = processTemplates(
        value as Record<string, unknown>,
        outputs
      );
    } else {
      processed[key] = value;
    }
  }

  return processed;
}

/**
 * Format a resolved value as a valid JavaScript expression for code context.
 * Strings are JSON-quoted so they stay valid when inlined into user code.
 * Numbers, booleans, arrays, and objects serialize to valid JS literals.
 * null/undefined become "null".
 */
function formatCodeValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

/**
 * Resolve template variables in a code string, producing valid JS expressions.
 * Unlike processTemplates (which inlines raw strings), this function
 * JSON-stringifies string values so they remain valid JS when inlined.
 *
 * Handles both stored format {{@nodeId:Label.field}} and display format
 * {{Label.field}} (fallback).
 */
function processCodeTemplates(code: string, outputs: NodeOutputs): string {
  const storedPattern = /\{\{@([^:]+):([^}]+)\}\}/g;
  const displayPattern = /\{\{([^@}][^}]*)\}\}/g;

  let result = code.replace(storedPattern, (full, nodeId: string, rest: string) => {
    const trimmedNodeId = nodeId.trim();
    const sanitizedNodeId = trimmedNodeId.replace(/[^a-zA-Z0-9]/g, "_");
    const output = outputs[sanitizedNodeId] ?? outputs[trimmedNodeId];
    if (!output) {
      return full;
    }
    const { data } = output;
    if (data === null || data === undefined) {
      return "null";
    }
    const fieldPath = rest.includes(".")
      ? rest.substring(rest.indexOf(".") + 1).trim()
      : "";
    const resolved = resolveFromOutputData(data, fieldPath);
    return formatCodeValue(resolved ?? null);
  });

  result = result.replace(displayPattern, (_full, displayRef: string) => {
    const resolved = resolveDisplayTemplate(displayRef, outputs);
    return formatCodeValue(resolved ?? null);
  });

  return result;
}

/**
 * Resolve a display-format template (e.g. "Label.field") by searching outputs
 * for a node whose label matches, then resolving the field path from its data.
 * Uses case-insensitive label matching to stay consistent with the UI-side
 * findNodeOutputByLabel in lib/utils/template.ts.
 */
export function resolveDisplayTemplate(
  displayRef: string,
  outputs: NodeOutputs
): unknown {
  const dotIndex = displayRef.indexOf(".");
  const label =
    dotIndex === -1 ? displayRef : displayRef.substring(0, dotIndex);
  const fieldPath = dotIndex === -1 ? "" : displayRef.substring(dotIndex + 1);

  const entry = findOutputByLabel(label, outputs);
  if (!entry) {
    return null;
  }

  if (entry.data === null || entry.data === undefined) {
    return null;
  }

  return resolveFromOutputData(entry.data, fieldPath) ?? null;
}

/**
 * Extract template references from a SQL query string and convert them to
 * PostgreSQL parameterized query placeholders ($1, $2, ...).
 * Returns the parameterized SQL and an ordered array of resolved values,
 * preserving native types for proper SQL parameterization.
 *
 * Handles both stored format {{@nodeId:Label.field}} and display format
 * {{Label.field}} (fallback when the editor doesn't convert to stored format).
 *
 * Quote stripping requires symmetric quotes: '{{...}}' strips both quotes
 * so the parameter binds correctly. Asymmetric quotes (e.g. '{{...}} without
 * a closing quote) are left intact to avoid silently eating SQL syntax.
 */
export function extractTemplateParameters(
  query: string,
  outputs: NodeOutputs
): { parameterizedQuery: string; paramValues: unknown[] } {
  const paramValues: unknown[] = [];
  let paramIndex = 0;

  const replaceStored = (
    _match: string,
    nodeId: string,
    rest: string
  ): string => {
    paramIndex++;
    paramValues.push(resolveTemplateToRawValue(nodeId, rest, outputs));
    return `$${paramIndex}`;
  };

  const replaceDisplay = (_match: string, displayRef: string): string => {
    paramIndex++;
    paramValues.push(resolveDisplayTemplate(displayRef, outputs));
    return `$${paramIndex}`;
  };

  // Stored format: fully-quoted first (strip both quotes), then unquoted
  let result = query.replace(/'\{\{@([^:]+):([^}]+)\}\}'/g, replaceStored);
  result = result.replace(/\{\{@([^:]+):([^}]+)\}\}/g, replaceStored);

  // Display format: fully-quoted first (strip both quotes), then unquoted
  result = result.replace(/'\{\{([^@}][^}]*)\}\}'/g, replaceDisplay);
  result = result.replace(/\{\{([^@}][^}]*)\}\}/g, replaceDisplay);

  return { parameterizedQuery: result, paramValues };
}

/**
 * Find a node output by case-insensitive label matching.
 * Used as a fallback when direct node ID lookup fails.
 */
function findOutputByLabel(
  label: string,
  outputs: NodeOutputs
): { label: string; data: unknown } | undefined {
  const normalizedLabel = label.toLowerCase().trim();
  for (const entry of Object.values(outputs)) {
    if (entry.label.toLowerCase().trim() === normalizedLabel) {
      return entry;
    }
  }
  return;
}

/**
 * Resolve a single template to its raw value (preserving native type).
 * Unlike replaceConfigTemplate which stringifies, this returns the native
 * type (number, string, boolean, etc.) for proper SQL parameterization.
 *
 * Falls back to case-insensitive label matching when the node ID lookup
 * fails, keeping parity with the display-format resolution path.
 */
export function resolveTemplateToRawValue(
  nodeId: string,
  rest: string,
  outputs: NodeOutputs
): unknown {
  const trimmedNodeId = nodeId.trim();
  const sanitizedNodeId = trimmedNodeId.replace(/[^a-zA-Z0-9]/g, "_");
  const output = outputs[sanitizedNodeId] ?? outputs[trimmedNodeId];
  const fieldPath = rest.includes(".")
    ? rest.substring(rest.indexOf(".") + 1).trim()
    : "";

  const resolvedOutput = output ?? findOutputByLabelFallback(rest, outputs);

  if (!resolvedOutput) {
    return null;
  }

  const data = resolvedOutput.data;
  if (data === null || data === undefined) {
    return null;
  }

  return resolveFromOutputData(data, fieldPath) ?? null;
}

/**
 * Attempt label-based fallback lookup when node ID is not found in outputs.
 */
function findOutputByLabelFallback(
  rest: string,
  outputs: NodeOutputs
): { label: string; data: unknown } | undefined {
  const dotIndex = rest.indexOf(".");
  const label = dotIndex === -1 ? rest : rest.substring(0, dotIndex);
  return findOutputByLabel(label, outputs);
}

// ---------------------------------------------------------------------------
// For Each / Collect helpers
// ---------------------------------------------------------------------------

export type LoopBodyInfo = {
  bodyNodeIds: string[];
  collectNodeId: string | undefined;
  bodyEdgesBySource: Map<string, string[]>;
  bodyEdgesBySourceHandle: EdgesBySourceHandle;
};

/**
 * Compute the next BFS depth when traversing loop body nodes.
 * Inner For Each increments depth, inner Collect decrements it.
 */
function computeNextDepth(
  isForEach: boolean,
  isCollect: boolean,
  currentDepth: number
): number {
  if (isForEach) {
    return currentDepth + 1;
  }
  if (isCollect) {
    return currentDepth - 1;
  }
  return currentDepth;
}

/**
 * Identify the loop body subgraph between a For Each node and its paired
 * Collect node. Uses BFS with depth tracking so nested For Each / Collect
 * pairs are correctly skipped.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: BFS with depth tracking requires multiple condition branches
export function identifyLoopBody(
  forEachNodeId: string,
  edgesBySource: Map<string, string[]>,
  nodeMap: Map<string, WorkflowNode>,
  edgesBySourceHandle?: EdgesBySourceHandle
): LoopBodyInfo {
  const bodyNodeIds: string[] = [];
  const bodyEdgesBySource = new Map<string, string[]>();
  const bodyEdgesBySourceHandle: EdgesBySourceHandle = new Map();
  let collectNodeId: string | undefined;
  const visited = new Set<string>();

  // Seed queue with direct children of the For Each node
  const initialTargets = edgesBySource.get(forEachNodeId) ?? [];
  for (const targetId of initialTargets) {
    if (!bodyEdgesBySource.has(forEachNodeId)) {
      bodyEdgesBySource.set(forEachNodeId, []);
    }
    bodyEdgesBySource.get(forEachNodeId)!.push(targetId);
  }

  const queue: Array<{ nodeId: string; depth: number }> = initialTargets.map(
    (id) => ({ nodeId: id, depth: 0 })
  );

  while (queue.length > 0) {
    const entry = queue.shift();
    if (!entry) {
      break;
    }
    const { nodeId, depth } = entry;

    if (visited.has(nodeId)) {
      continue;
    }
    visited.add(nodeId);

    const node = nodeMap.get(nodeId);
    if (!node) {
      continue;
    }

    const actionType = node.data.config?.actionType as string | undefined;
    const isCollect = node.data.type === "action" && actionType === "Collect";
    const isForEach = node.data.type === "action" && actionType === "For Each";

    // Collect at depth 0 is OUR boundary
    if (isCollect && depth === 0) {
      if (collectNodeId && collectNodeId !== nodeId) {
        throw new Error(
          "For Each node has multiple Collect nodes at the same nesting level. " +
            "Each For Each must have exactly one Collect boundary."
        );
      }
      collectNodeId = nodeId;
      continue; // Don't traverse past our Collect
    }

    bodyNodeIds.push(nodeId);

    const nextDepth = computeNextDepth(isForEach, isCollect, depth);
    const nextIds = edgesBySource.get(nodeId) ?? [];
    for (const nextId of nextIds) {
      if (!bodyEdgesBySource.has(nodeId)) {
        bodyEdgesBySource.set(nodeId, []);
      }
      bodyEdgesBySource.get(nodeId)!.push(nextId);
      queue.push({ nodeId: nextId, depth: nextDepth });
    }
  }

  // Copy handle-aware edges, filtering targets to body-only nodes so
  // condition handles cannot accidentally route outside the loop body.
  const bodyNodeSet = new Set(bodyNodeIds);
  for (const bodyNodeId of bodyNodeIds) {
    const nodeHandleMap = edgesBySourceHandle?.get(bodyNodeId);
    if (!nodeHandleMap) {
      continue;
    }
    const filteredHandleMap = new Map<string, string[]>();
    for (const [handle, targets] of nodeHandleMap) {
      const filteredTargets = targets.filter((t) => bodyNodeSet.has(t));
      if (filteredTargets.length > 0) {
        filteredHandleMap.set(handle, filteredTargets);
      }
    }
    if (filteredHandleMap.size > 0) {
      bodyEdgesBySourceHandle.set(bodyNodeId, filteredHandleMap);
    }
  }

  return { bodyNodeIds, collectNodeId, bodyEdgesBySource, bodyEdgesBySourceHandle };
}

/**
 * Resolve a template string to its raw array value.
 * Accepts {{@nodeId:Label.field}} syntax or a JSON array literal.
 */
export function resolveArraySource(
  source: unknown,
  outputs: NodeOutputs
): unknown[] {
  if (typeof source !== "string" || !source.trim()) {
    throw new Error(
      "For Each: arraySource is required. " +
        "Configure a template reference to an array (e.g., {{@nodeId:Label.rows}})."
    );
  }

  const match = source.trim().match(ARRAY_SOURCE_RE);

  if (!match) {
    // Try to parse as a JSON array literal
    try {
      const parsed: unknown = JSON.parse(source);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // Not valid JSON
    }
    throw new Error(
      `For Each: arraySource "${source}" is not a valid template reference. ` +
        "Use {{@nodeId:Label.field}} syntax to reference an array from an upstream node."
    );
  }

  const [, nodeId, label, fieldPath] = match;
  const rest = fieldPath ? `${label}.${fieldPath}` : label;
  const raw = resolveTemplateToRawValue(nodeId, rest, outputs);

  if (raw === null || raw === undefined) {
    const sanitizedId = nodeId.trim().replace(/[^a-zA-Z0-9]/g, "_");
    const nodeExists =
      outputs[sanitizedId] !== undefined ||
      outputs[nodeId.trim()] !== undefined;
    const detail = nodeExists
      ? "The referenced node executed but its output resolved to null."
      : `Node "${nodeId.trim()}" was not found in outputs. Ensure it has executed before this For Each.`;
    throw new Error(
      `For Each: arraySource resolved to ${String(raw)}. ${detail}`
    );
  }

  if (!Array.isArray(raw)) {
    throw new Error(
      `For Each: arraySource must resolve to an array, got ${typeof raw}. ` +
        `Referenced: ${source}`
    );
  }

  return raw;
}
/**
 * Main workflow executor function
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Core workflow engine function requires comprehensive logic
export async function executeWorkflow(input: WorkflowExecutionInput) {
  "use workflow";

  console.log("[Workflow Executor] Starting workflow execution");

  const {
    nodes,
    edges,
    triggerInput = {},
    executionId,
    workflowId,
    organizationId,
    organizationName,
    organizationSlug,
    ownerId,
  } = input;

  console.log("[Workflow Executor] Input:", {
    nodeCount: nodes.length,
    edgeCount: edges.length,
    hasExecutionId: !!executionId,
    workflowId: workflowId || "none",
    organizationId: organizationId || "none",
  });

  // Common labels for error logging. Org/owner identifiers are also pushed
  // into AsyncLocalStorage below so plugin steps inherit them without each
  // call site having to thread labels manually.
  const baseLogLabels: Record<string, string> = {
    ...(workflowId ? { workflow_id: workflowId } : {}),
    ...(executionId ? { execution_id: executionId } : {}),
    ...(organizationId ? { org_id: organizationId } : {}),
    ...(organizationSlug ? { org_slug: organizationSlug } : {}),
    ...(organizationName ? { org_name: organizationName } : {}),
    ...(ownerId ? { owner_id: ownerId } : {}),
  };

  // Enter async-local context so any logUserError/logSystemError called from
  // this point on (including inside plugin steps) automatically includes
  // org/owner/workflow identifiers without manual threading.
  enterWorkflowErrorContext({
    workflow_id: workflowId,
    execution_id: executionId,
    org_id: organizationId,
    org_slug: organizationSlug,
    owner_id: ownerId,
  });

  const outputs: NodeOutputs = {};
  const results: Record<string, ExecutionResult> = {};

  // Build node and edge maps
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const edgesBySource = buildEdgesBySource(edges);
  const edgesBySourceHandle = buildEdgesBySourceHandle(edges);
  const conditionDecisions = new Map<string, ConditionDecision>();

  const edgesByTarget = buildEdgesByTarget(edges);
  const convergenceArrivals = new Map<string, Set<string>>();

  // Find trigger nodes
  const nodesWithIncoming = new Set(edges.map((e) => e.target));
  const triggerNodes = nodes.filter(
    (node) => node.data.type === "trigger" && !nodesWithIncoming.has(node.id)
  );

  console.log(
    "[Workflow Executor] Found",
    triggerNodes.length,
    "trigger nodes"
  );

  // Detect trigger type for step context (gas strategy uses this for multiplier selection)
  const workflowTriggerType: string = (() => {
    const triggerNode = nodes.find((n) => n.data.type === "trigger");
    if (!triggerNode) {
      return "manual";
    }
    const tt = triggerNode.data.config?.triggerType as string | undefined;
    if (tt === "Webhook") {
      return "webhook";
    }
    if (tt === "Scheduled" || tt === "Schedule") {
      return "scheduled";
    }
    if (tt === "Event") {
      return "event";
    }
    return "manual";
  })();

  // Helper to get a meaningful node name
  function getNodeName(node: WorkflowNode): string {
    if (node.data.label) {
      return node.data.label;
    }
    if (node.data.type === "action") {
      const actionType = node.data.config?.actionType as string;
      if (actionType) {
        // Look up the human-readable label from the step registry;
        // fall back to actionType itself (system actions like "HTTP Request",
        // "Database Query", "Condition" use their type name as the label)
        return getActionLabel(actionType) ?? actionType;
      }
      return "Action";
    }
    if (node.data.type === "trigger") {
      return (node.data.config?.triggerType as string) || "Trigger";
    }
    return node.data.type;
  }
  /**
   * Process a node's config by resolving templates and handling special fields
   * (condition, dbQuery). Shared by executeNode and executeBodyNode.
   */
  function processActionConfig(
    config: Record<string, unknown>,
    actionType: string,
    currentOutputs: NodeOutputs
  ): Record<string, unknown> {
    const configWithoutSpecial = { ...config };
    const originalCondition = config.condition;
    configWithoutSpecial.condition = undefined;
    const originalConditionConfig = config.conditionConfig;
    configWithoutSpecial.conditionConfig = undefined;
    const originalDbQuery = config.dbQuery;
    if (actionType === "Database Query") {
      configWithoutSpecial.dbQuery = undefined;
    }
    const originalCode = config.code;
    if (actionType === "code/run-code") {
      configWithoutSpecial.code = undefined;
    }

    const processedConfig = processTemplates(
      configWithoutSpecial,
      currentOutputs
    );

    if (originalCondition !== undefined) {
      processedConfig.condition = originalCondition;
    }
    if (originalConditionConfig !== undefined) {
      processedConfig.conditionConfig = originalConditionConfig;
    }

    if (
      actionType === "Database Query" &&
      typeof originalDbQuery === "string"
    ) {
      const { parameterizedQuery, paramValues } = extractTemplateParameters(
        originalDbQuery,
        currentOutputs
      );
      processedConfig.dbQuery = parameterizedQuery;
      processedConfig._dbParams = paramValues;
    } else if (
      actionType === "Database Query" &&
      originalDbQuery !== undefined
    ) {
      processedConfig.dbQuery = originalDbQuery;
    }

    if (actionType === "code/run-code" && typeof originalCode === "string") {
      processedConfig.code = processCodeTemplates(originalCode, currentOutputs);
    }

    return processedConfig;
  }

  // -------------------------------------------------------------------
  // For Each: body-node executor (scoped outputs, body-only edges)
  // -------------------------------------------------------------------

  /**
   * Execute a single body node within a For Each iteration.
   * Uses scoped outputs so loop variable references resolve correctly
   * and body-specific edges so traversal stays within the loop body.
   */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Body execution mirrors main executeNode with loop-specific scoping
  async function executeBodyNode(
    nodeId: string,
    bodyVisited: Set<string>,
    scopedOutputs: NodeOutputs,
    bodyResults: Record<string, ExecutionResult>,
    bodyEdgesBySource: Map<string, string[]>,
    collectNodeId: string | undefined,
    iterationMeta?: { iterationIndex: number; forEachNodeId: string },
    bodyHandleMap?: EdgesBySourceHandle
  ): Promise<void> {
    if (bodyVisited.has(nodeId)) {
      return;
    }
    if (nodeId === collectNodeId) {
      return; // Don't execute the Collect boundary
    }
    bodyVisited.add(nodeId);

    const node = nodeMap.get(nodeId);
    if (!node) {
      return;
    }

    // Skip disabled nodes
    if (node.data.enabled === false) {
      const sanitizedId = nodeId.replace(/[^a-zA-Z0-9]/g, "_");
      scopedOutputs[sanitizedId] = {
        label: getNodeName(node),
        data: null,
      };
      const nextNodes = bodyEdgesBySource.get(nodeId) ?? [];
      for (const next of nextNodes) {
        await executeBodyNode(
          next,
          bodyVisited,
          scopedOutputs,
          bodyResults,
          bodyEdgesBySource,
          collectNodeId,
          iterationMeta,
          bodyHandleMap
        );
      }
      return;
    }

    // Inject builtin variables
    const builtinSanitized = BUILTIN_NODE_ID.replace(/[^a-zA-Z0-9]/g, "_");
    scopedOutputs[builtinSanitized] = {
      label: BUILTIN_NODE_LABEL,
      data: getBuiltinVariables(),
    };

    try {
      const config = node.data.config ?? {};
      const actionType = config.actionType as string | undefined;

      if (!actionType) {
        bodyResults[nodeId] = {
          success: false,
          error: `Action node "${node.data.label || node.id}" has no action type configured`,
        };
        return;
      }

      const processedConfig = processActionConfig(
        config,
        actionType,
        scopedOutputs
      );

      const stepContext: StepContext = {
        executionId,
        nodeId: node.id,
        nodeName: getNodeName(node),
        nodeType: actionType,
        iterationIndex: iterationMeta?.iterationIndex,
        forEachNodeId: iterationMeta?.forEachNodeId,
        organizationId,
        orgSlug: organizationSlug,
        ownerId,
        workflowId,
      };

      const stepResult = await executeActionStep({
        actionType,
        config: processedConfig,
        outputs: scopedOutputs,
        context: stepContext,
      });

      const isErrorResult =
        stepResult &&
        typeof stepResult === "object" &&
        "success" in stepResult &&
        (stepResult as { success: boolean }).success === false;

      const result: ExecutionResult = isErrorResult
        ? {
            success: false,
            error:
              (stepResult as { error?: string }).error ||
              `Step "${actionType}" failed.`,
          }
        : { success: true, data: stepResult };

      bodyResults[nodeId] = result;
      const sanitizedId = nodeId.replace(/[^a-zA-Z0-9]/g, "_");
      scopedOutputs[sanitizedId] = {
        label: getNodeName(node),
        data: result.data,
      };

      if (!result.success) {
        return;
      }

      // Nested For Each inside the body
      if (actionType === "For Each") {
        await handleForEachExecution({
          forEachNodeId: nodeId,
          forEachNode: node,
          processedConfig,
          currentOutputs: scopedOutputs,
          currentResults: bodyResults,
          currentVisited: bodyVisited,
          currentEdgesBySource: bodyEdgesBySource,
          continueAfterCollect: async (collectId) => {
            const nextNodes = bodyEdgesBySource.get(collectId) ?? [];
            for (const next of nextNodes) {
              await executeBodyNode(
                next,
                bodyVisited,
                scopedOutputs,
                bodyResults,
                bodyEdgesBySource,
                collectNodeId,
                iterationMeta,
                bodyHandleMap
              );
            }
          },
        });
      } else if (actionType === "Condition") {
        const conditionValue = (result.data as { condition?: boolean })
          ?.condition;
        const nodeHandles = bodyHandleMap?.get(nodeId);
        if (nodeHandles) {
          const handleId = conditionValue === true ? "true" : "false";
          const handleTargets = nodeHandles.get(handleId) ?? [];
          if (handleTargets.length > 0) {
            for (const next of handleTargets) {
              await executeBodyNode(
                next,
                bodyVisited,
                scopedOutputs,
                bodyResults,
                bodyEdgesBySource,
                collectNodeId,
                iterationMeta,
                bodyHandleMap
              );
            }
          }
        } else if (conditionValue !== true) {
          // Legacy fallback: gate behavior
          return;
        }
      }

      // Continue to downstream body nodes.
      // Skip only when condition routed via handles AND the chosen handle had targets.
      const conditionRoutedViaHandles =
        actionType === "Condition" &&
        bodyHandleMap?.has(nodeId) &&
        (bodyHandleMap
          .get(nodeId)
          ?.get(
            (result.data as { condition?: boolean })?.condition === true
              ? "true"
              : "false"
          )?.length ?? 0) > 0;
      if (!conditionRoutedViaHandles) {
        const nextNodes = bodyEdgesBySource.get(nodeId) ?? [];
        for (const next of nextNodes) {
          await executeBodyNode(
            next,
            bodyVisited,
            scopedOutputs,
            bodyResults,
            bodyEdgesBySource,
            collectNodeId,
            iterationMeta,
            bodyHandleMap
          );
        }
      }
    } catch (error) {
      const errorMessage = await getErrorMessageAsync(error);
      bodyResults[nodeId] = { success: false, error: errorMessage };
    }
  }

  // -------------------------------------------------------------------
  // For Each: iteration orchestrator
  // -------------------------------------------------------------------

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Orchestrates loop iteration with error handling and result collection
  async function handleForEachExecution(params: {
    forEachNodeId: string;
    forEachNode: WorkflowNode;
    processedConfig: Record<string, unknown>;
    currentOutputs: NodeOutputs;
    currentResults: Record<string, ExecutionResult>;
    currentVisited: Set<string>;
    currentEdgesBySource: Map<string, string[]>;
    continueAfterCollect?: (collectNodeId: string) => Promise<void>;
  }): Promise<{
    arrayLength: number;
    maxIterations: number;
    iterationsRan: number;
  }> {
    const {
      forEachNodeId,
      forEachNode,
      processedConfig,
      currentOutputs,
      currentResults,
      currentVisited,
      currentEdgesBySource,
      continueAfterCollect,
    } = params;

    // 1. Resolve array
    const resolvedArray = resolveArraySource(
      processedConfig.arraySource,
      currentOutputs
    );
    const parsedMax = Number(processedConfig.maxIterations);
    const maxIterations = parsedMax > 0 ? parsedMax : resolvedArray.length;
    const itemsToProcess = resolvedArray.slice(0, maxIterations);

    // 2. Identify body subgraph
    const { bodyNodeIds, collectNodeId, bodyEdgesBySource, bodyEdgesBySourceHandle } = identifyLoopBody(
      forEachNodeId,
      currentEdgesBySource,
      nodeMap,
      edgesBySourceHandle
    );

    const sanitizedForEachId = forEachNodeId.replace(/[^a-zA-Z0-9]/g, "_");

    // 3. Single iteration executor
    const mapExpression = processedConfig.mapExpression as string | undefined;

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: iteration logic has inherent complexity from scoped output capture, body execution, and map expression
    async function executeIteration(
      item: unknown,
      index: number
    ): Promise<unknown> {
      const scopedOutputs: NodeOutputs = structuredClone(currentOutputs);
      const bodyResults: Record<string, ExecutionResult> = {};

      // Apply map expression to transform each item before body execution
      let currentItem: unknown = item;
      if (mapExpression && typeof item === "object" && item !== null) {
        currentItem = resolveFromOutputData(item, mapExpression) ?? item;
      }

      // Inject loop variables
      scopedOutputs[sanitizedForEachId] = {
        label: getNodeName(forEachNode),
        data: {
          currentItem,
          index,
          totalItems: itemsToProcess.length,
        },
      };

      // Execute body starting from For Each's direct children
      const bodyVisited = new Set<string>();
      const firstBodyNodes = bodyEdgesBySource.get(forEachNodeId) ?? [];
      const iterationMeta = { iterationIndex: index, forEachNodeId };

      for (const bodyNodeId of firstBodyNodes) {
        await executeBodyNode(
          bodyNodeId,
          bodyVisited,
          scopedOutputs,
          bodyResults,
          bodyEdgesBySource,
          collectNodeId,
          iterationMeta,
          bodyEdgesBySourceHandle
        );
      }

      // If any body node failed, surface the error in the iteration result
      const bodyFailure = Object.entries(bodyResults).find(
        ([, r]) => !r.success
      );
      if (bodyFailure) {
        return {
          success: false as const,
          error: bodyFailure[1].error ?? "Body node failed",
          nodeId: bodyFailure[0],
        };
      }

      // Capture output from the last body node(s) that produced data.
      // First check nodes directly before Collect; if those were skipped
      // (e.g., a Condition that evaluated false), fall back to the last
      // body node that actually produced output.
      let iterationOutput: unknown;
      if (collectNodeId) {
        // Primary: nodes whose edges target Collect
        for (const bodyNodeId of bodyNodeIds) {
          const targets = bodyEdgesBySource.get(bodyNodeId) ?? [];
          if (targets.includes(collectNodeId)) {
            const sanitizedBodyId = bodyNodeId.replace(/[^a-zA-Z0-9]/g, "_");
            const output = scopedOutputs[sanitizedBodyId];
            if (output?.data !== undefined) {
              iterationOutput = output.data;
            }
          }
        }

        // Fallback: last body node with output (handles skipped Conditions)
        if (iterationOutput === undefined) {
          for (const bodyNodeId of bodyNodeIds) {
            const sanitizedBodyId = bodyNodeId.replace(/[^a-zA-Z0-9]/g, "_");
            const output = scopedOutputs[sanitizedBodyId];
            if (output?.data !== undefined) {
              iterationOutput = output.data;
            }
          }
        }
      }

      // Final fallback: use the mapped item itself
      if (iterationOutput === undefined) {
        iterationOutput = currentItem;
      }

      return iterationOutput;
    }

    // 4. Run iterations with configurable concurrency
    const { runIterations } = await import(
      "@/lib/for-each-concurrency"
    );
    const concurrencyMode =
      (processedConfig.concurrency as string) || "sequential";
    const concurrencyLimit = Number(processedConfig.concurrencyLimit) || 0;
    const iterationResults = await runIterations(
      itemsToProcess,
      executeIteration,
      getErrorMessageAsync,
      concurrencyMode as "sequential" | "parallel" | "custom",
      concurrencyLimit
    );

    // 5. Mark body nodes as visited in the parent scope
    for (const bodyNodeId of bodyNodeIds) {
      currentVisited.add(bodyNodeId);
    }

    // 6. Store Collect output and continue downstream (only when Collect exists)
    if (collectNodeId) {
      const collectData = {
        results: iterationResults,
        count: iterationResults.length,
      };
      const sanitizedCollectId = collectNodeId.replace(/[^a-zA-Z0-9]/g, "_");
      const collectNode = nodeMap.get(collectNodeId);
      const collectLabel = collectNode ? getNodeName(collectNode) : "Collect";

      // Execute Collect step for logging / observability
      const collectAction = SYSTEM_ACTIONS.Collect;
      if (collectAction) {
        const mod = await collectAction.importer();
        await mod[collectAction.stepFunction]({
          ...collectData,
          _context: {
            executionId,
            nodeId: collectNodeId,
            nodeName: collectLabel,
            nodeType: "Collect",
            forEachNodeId,
            organizationId,
            orgSlug: organizationSlug,
            ownerId,
            workflowId,
          } satisfies StepContext,
        });
      }

      currentOutputs[sanitizedCollectId] = {
        label: collectLabel,
        data: collectData,
      };
      currentResults[collectNodeId] = { success: true, data: collectData };
      currentVisited.add(collectNodeId);

      if (continueAfterCollect) {
        await continueAfterCollect(collectNodeId);
      }
    }

    return {
      arrayLength: resolvedArray.length,
      maxIterations,
      iterationsRan: itemsToProcess.length,
    };
  }

  function processSettledResults(
    settled: PromiseSettledResult<void>[],
    nodeIds: string[]
  ): void {
    for (const [i, outcome] of settled.entries()) {
      if (outcome.status === "rejected") {
        const nodeId = nodeIds[i];
        if (!(nodeId in results)) {
          const errorMessage =
            outcome.reason instanceof Error
              ? outcome.reason.message
              : String(outcome.reason);
          results[nodeId] = { success: false, error: errorMessage };
        }
      }
    }
  }

  /**
   * Execute downstream nodes with convergence barrier support.
   * For convergence nodes (multiple incoming edges), waits until all
   * upstream branches have signaled arrival before executing.
   */
  async function executeReadyDownstream(
    fromNodeId: string,
    nextNodeIds: string[],
    visited: Set<string>
  ): Promise<void> {
    const readyIds = getReadyDownstreamIds(
      fromNodeId,
      nextNodeIds,
      edgesByTarget,
      convergenceArrivals,
      visited
    );

    if (readyIds.length > 0) {
      const settled = await Promise.allSettled(
        readyIds.map((id) => executeNode(id, visited))
      );
      processSettledResults(settled, readyIds);
    }
  }

  // Helper to execute a single node
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Node execution requires type checking and error handling
  async function executeNode(nodeId: string, visited: Set<string> = new Set()) {
    console.log("[Workflow Executor] Executing node:", nodeId);

    if (visited.has(nodeId)) {
      console.log("[Workflow Executor] Node already visited, skipping");
      return; // Prevent cycles
    }
    visited.add(nodeId);

    const node = nodeMap.get(nodeId);
    if (!node) {
      console.log("[Workflow Executor] Node not found:", nodeId);
      return;
    }

    // Skip disabled nodes
    if (node.data.enabled === false) {
      console.log("[Workflow Executor] Skipping disabled node:", nodeId);

      // Store null output for disabled nodes so downstream templates don't fail
      const sanitizedNodeId = nodeId.replace(/[^a-zA-Z0-9]/g, "_");
      outputs[sanitizedNodeId] = {
        label: getNodeName(node),
        data: null,
      };

      const nextNodes = edgesBySource.get(nodeId) ?? [];
      await executeReadyDownstream(nodeId, nextNodes, visited);
      return;
    }

    // Inject fresh built-in system variables before each node executes.
    // Intentionally per-node (not per-workflow) so long-running sequential
    // workflows get an up-to-date timestamp at each step.
    const builtinSanitizedId = BUILTIN_NODE_ID.replace(/[^a-zA-Z0-9]/g, "_");
    outputs[builtinSanitizedId] = {
      label: BUILTIN_NODE_LABEL,
      data: getBuiltinVariables(),
    };

    try {
      let result: ExecutionResult;

      if (node.data.type === "trigger") {
        console.log("[Workflow Executor] Executing trigger node");

        const config = node.data.config || {};
        const triggerType = config.triggerType as string;
        let triggerData: Record<string, unknown> = {
          triggered: true,
          timestamp: Date.now(),
          triggeredAt: new Date().toISOString(),
        };

        // Handle webhook mock request for test runs
        if (
          triggerType === "Webhook" &&
          config.webhookMockRequest &&
          (!triggerInput || Object.keys(triggerInput).length === 0)
        ) {
          try {
            const mockData = JSON.parse(config.webhookMockRequest as string);
            triggerData = { ...triggerData, ...mockData };
            console.log(
              "[Workflow Executor] Using webhook mock request data:",
              mockData
            );
          } catch (error) {
            logUserError(
              ErrorCategory.VALIDATION,
              "[Workflow Executor] Failed to parse webhook mock request:",
              error,
              baseLogLabels
            );
          }
        } else if (triggerInput && Object.keys(triggerInput).length > 0) {
          // Use provided trigger input
          // For Event triggers, deserialize { value: string, type: string } objects
          // back to appropriate types (BigInt for uint/int, boolean for bool, etc.)
          if (triggerType === "Event") {
            const deserialized = deserializeEventTriggerData(triggerInput);
            triggerData = {
              ...triggerData,
              ...deserialized,
            };

            // Enrich event data with explorer links so the execution log UI
            // can render clickable transaction/address links.
            // Uses a step function to keep db/schema out of the workflow bundle.
            if (config.network) {
              try {
                const { enrichExplorerLinks } = await import(
                  "@/lib/steps/enrich-explorer-links"
                );
                await enrichExplorerLinks(
                  triggerData,
                  config.network as string | number
                );
              } catch {
                // Non-critical: skip explorer links if lookup fails
              }
            }
          } else {
            // For other trigger types, use as-is
            triggerData = { ...triggerData, ...triggerInput };
            // Normalize schedule trigger: map triggerTime -> triggeredAt
            // so the runtime field matches the declared output schema
            if (
              triggerType === "Schedule" &&
              "triggerTime" in triggerInput &&
              triggerInput.triggerTime
            ) {
              triggerData.triggeredAt = triggerInput.triggerTime;
            }
          }
        }

        // Build context for logging
        const triggerContext: StepContext = {
          executionId,
          nodeId: node.id,
          nodeName: getNodeName(node),
          nodeType: node.data.type,
          organizationId,
          orgSlug: organizationSlug,
          ownerId,
          workflowId,
        };

        // Execute trigger step (handles logging internally)
        const triggerResult = await triggerStep({
          triggerData,
          _context: triggerContext,
        });

        // Store the full trigger result (not unwrapped) so the shape
        // matches what withStepLogging writes to the execution log.
        // This keeps autocomplete-suggested paths (e.g. data.triggeredAt)
        // consistent with what resolveFromOutputData resolves at runtime.
        // Direct field names (e.g. triggeredAt) still work via the
        // hasNestedDataShape fallback in resolveFromOutputData.
        result = {
          success: triggerResult.success,
          data: triggerResult,
        };
      } else if (node.data.type === "action") {
        const config = node.data.config || {};
        const actionType = config.actionType as string | undefined;

        console.log("[Workflow Executor] Executing action node:", actionType);

        // Check if action type is defined
        if (!actionType) {
          result = {
            success: false,
            error: `Action node "${node.data.label || node.id}" has no action type configured`,
          };
          results[nodeId] = result;
          return;
        }

        const processedConfig = processActionConfig(config, actionType, outputs);

        // Build step context for logging (stepHandler will handle the logging)
        const stepContext: StepContext = {
          executionId,
          nodeId: node.id,
          nodeName: getNodeName(node),
          nodeType: actionType,
          triggerType: workflowTriggerType,
          organizationId,
          orgSlug: organizationSlug,
          ownerId,
          workflowId,
        };

        // Execute the action step with stepHandler (logging is handled inside)
        // IMPORTANT: We pass integrationId via config, not actual credentials
        // Steps fetch credentials internally using fetchCredentials(integrationId)
        console.log("[Workflow Executor] Calling executeActionStep");
        const stepResult = await executeActionStep({
          actionType,
          config: processedConfig,
          outputs,
          context: stepContext,
          nodeMap,
          executionResults: results,
        });

        console.log("[Workflow Executor] Step result received:", {
          hasResult: !!stepResult,
          resultType: typeof stepResult,
        });

        // Check if the step returned an error result
        const isErrorResult =
          stepResult &&
          typeof stepResult === "object" &&
          "success" in stepResult &&
          (stepResult as { success: boolean }).success === false;

        if (isErrorResult) {
          const errorResult = stepResult as { success: false; error?: string };
          result = {
            success: false,
            error:
              errorResult.error ||
              `Step "${actionType}" in node "${node.data.label || node.id}" failed without a specific error message.`,
          };
        } else {
          result = {
            success: true,
            data: stepResult,
          };
        }
      } else {
        console.log("[Workflow Executor] Unknown node type:", node.data.type);
        result = {
          success: false,
          error: `Unknown node type "${node.data.type}" in node "${node.data.label || node.id}". Expected "trigger" or "action".`,
        };
      }

      // Store results
      results[nodeId] = result;

      // Store outputs with sanitized nodeId for template variable lookup
      const sanitizedNodeId = nodeId.replace(/[^a-zA-Z0-9]/g, "_");
      outputs[sanitizedNodeId] = {
        label: getNodeName(node),
        data: result.data,
      };

      console.log("[Workflow Executor] Node execution completed:", {
        nodeId,
        success: result.success,
      });

      // Execute next nodes
      if (result.success) {
        const currentActionType =
          node.data.type === "action"
            ? (node.data.config?.actionType as string | undefined)
            : undefined;

        if (currentActionType === "For Each") {
          // For Each: iterate over array, execute body subgraph per element,
          // store results on Collect, then continue from Collect downstream.
          const forEachConfig = processTemplates(
            node.data.config ?? {},
            outputs
          );
          const iterationSummary = await handleForEachExecution({
            forEachNodeId: nodeId,
            forEachNode: node,
            processedConfig: forEachConfig,
            currentOutputs: outputs,
            currentResults: results,
            currentVisited: visited,
            currentEdgesBySource: edgesBySource,
            continueAfterCollect: async (collectId) => {
              const nextNodes = edgesBySource.get(collectId) ?? [];
              await executeReadyDownstream(collectId, nextNodes, visited);
            },
          });

          // Update the For Each node's output with resolved iteration metadata
          const sanitizedFEId = nodeId.replace(/[^a-zA-Z0-9]/g, "_");
          outputs[sanitizedFEId] = {
            label: getNodeName(node),
            data: iterationSummary,
          };
          results[nodeId] = { success: true, data: iterationSummary };
        } else if (currentActionType === "Condition") {
          // For condition nodes, route to true/false handle targets
          const conditionResult = (result.data as { condition?: boolean })
            ?.condition;

          const handleMap = edgesBySourceHandle.get(nodeId);
          if (handleMap) {
            // Handle-aware routing: use sourceHandle to determine targets
            const handleId = conditionResult === true ? "true" : "false";
            const notTakenHandle = conditionResult === true ? "false" : "true";
            const handleTargets = handleMap.get(handleId) ?? [];

            // Record decision for branch-aware finalSuccess
            conditionDecisions.set(nodeId, {
              taken: handleId,
              skippedTargets: collectSkippedTargets(
                nodeId,
                notTakenHandle,
                edgesBySourceHandle
              ),
            });
            await executeReadyDownstream(nodeId, handleTargets, visited);

            // Propagate skip signals for the not-taken branch so convergence
            // nodes downstream receive arrival signals from skipped sources
            const skippedTargets = handleMap.get(notTakenHandle) ?? [];
            if (skippedTargets.length > 0) {
              const unblockedIds = propagateConvergenceSkips(
                skippedTargets,
                edgesBySource,
                edgesByTarget,
                convergenceArrivals,
                visited
              );
              if (unblockedIds.length > 0) {
                const settled = await Promise.allSettled(
                  unblockedIds.map((id) => executeNode(id, visited))
                );
                processSettledResults(settled, unblockedIds);
              }
            }
          } else {
            // Legacy fallback: no sourceHandle on edges, use old gate behavior
            if (conditionResult === true) {
              const nextNodes = edgesBySource.get(nodeId) ?? [];
              await executeReadyDownstream(nodeId, nextNodes, visited);
            }
          }
        } else {
          // For non-condition nodes, execute all next nodes in parallel
          const nextNodes = edgesBySource.get(nodeId) || [];
          console.log(
            "[Workflow Executor] Executing",
            nextNodes.length,
            "next nodes in parallel"
          );
          await executeReadyDownstream(nodeId, nextNodes, visited);
        }
      }
    } catch (error) {
      logSystemError(
        ErrorCategory.WORKFLOW_ENGINE,
        "[Workflow Executor] Error executing node:",
        error,
        {
          ...baseLogLabels,
          node_id: nodeId,
        }
      );
      const errorMessage = await getErrorMessageAsync(error);
      const errorResult = {
        success: false,
        error: errorMessage,
      };
      results[nodeId] = errorResult;

      // Store null output so downstream templates resolve to null rather than
      // being undefined (same pattern as disabled nodes).
      const sanitizedNodeId = nodeId.replace(/[^a-zA-Z0-9]/g, "_");
      outputs[sanitizedNodeId] = {
        label: getNodeName(node),
        data: null,
      };

      // Signal arrival at downstream convergence nodes to prevent deadlocks.
      // If this failure was the last arrival, execute the convergence node
      // with partial data rather than hanging forever.
      const nextNodes = edgesBySource.get(nodeId) ?? [];
      const unblockedIds = signalConvergenceArrival(
        nodeId,
        nextNodes,
        edgesByTarget,
        convergenceArrivals,
        visited
      );
      if (unblockedIds.length > 0) {
        const settled = await Promise.allSettled(
          unblockedIds.map((id) => executeNode(id, visited))
        );
        processSettledResults(settled, unblockedIds);
      }
    }
  }

  // Execute from each trigger node in parallel
  try {
    console.log("[Workflow Executor] Starting execution from trigger nodes");
    const workflowStartTime = Date.now();

    const triggerType = detectTriggerType(nodes);
    const metrics = getMetricsCollector();
    metrics.incrementCounter(MetricNames.WORKFLOW_EXECUTIONS_TOTAL, {
      [LabelKeys.TRIGGER_TYPE]: triggerType,
      ...(workflowId && { [LabelKeys.WORKFLOW_ID]: workflowId }),
    });
    incrementConcurrentExecutions();

    const triggerNodeIds = triggerNodes.map((trigger) => trigger.id);
    const triggerSettled = await Promise.allSettled(
      triggerNodeIds.map((id) => executeNode(id))
    );
    processSettledResults(triggerSettled, triggerNodeIds);

    // Branch-aware finalSuccess: exclude nodes on dead (not-taken) condition branches
    const allSkippedTargets = collectAllSkippedTargets(conditionDecisions);
    const finalSuccess = Object.entries(results).every(
      ([nodeId, r]) => r.success || allSkippedTargets.has(nodeId)
    );
    const duration = Date.now() - workflowStartTime;

    // Diagnostic logging for branching workflow failures
    if (!finalSuccess && conditionDecisions.size > 0) {
      const failedNodes = Object.entries(results)
        .filter(([, r]) => !r.success)
        .map(([id, r]) => ({ id, error: r.error }));
      const unexecutedNodes = [...nodeMap.keys()].filter(
        (id) => !(id in results)
      );
      console.log("[Workflow Executor] Branch-aware finalSuccess=false diagnostic:", {
        failedNodes,
        conditionDecisions: [...conditionDecisions.entries()].map(
          ([id, d]) => ({ id, ...d })
        ),
        skippedTargets: [...allSkippedTargets],
        unexecutedNodes,
      });
    }

    recordWorkflowComplete({
      workflowId,
      executionId,
      triggerType,
      durationMs: duration,
      success: finalSuccess,
      error: Object.values(results).find((r) => !r.success)?.error,
    });
    decrementConcurrentExecutions();

    console.log("[Workflow Executor] Workflow execution completed:", {
      success: finalSuccess,
      resultCount: Object.keys(results).length,
      duration,
    });

    // Update execution record if we have an executionId
    if (executionId) {
      try {
        await triggerStep({
          triggerData: {},
          _workflowComplete: {
            executionId,
            status: finalSuccess ? "success" : "error",
            output: Object.values(results).at(-1)?.data,
            error: finalSuccess
              ? undefined
              : Object.values(results).find((r) => !r.success)?.error,
            startTime: workflowStartTime,
          },
        });
      } catch (completeError) {
        logSystemError(
          ErrorCategory.WORKFLOW_ENGINE,
          "[Workflow Executor] Failed to update execution record:",
          completeError,
          baseLogLabels
        );
      }
    }

    return {
      success: finalSuccess,
      results,
      outputs,
    };
  } catch (error) {
    logSystemError(
      ErrorCategory.WORKFLOW_ENGINE,
      "[Workflow Executor] Fatal error during workflow execution:",
      error,
      baseLogLabels
    );

    const errorMessage = await getErrorMessageAsync(error);

    recordWorkflowComplete({
      workflowId,
      executionId,
      triggerType: detectTriggerType(nodes),
      durationMs: 0, // Unknown duration on fatal error
      success: false,
      error: errorMessage,
    });
    decrementConcurrentExecutions();

    // Update execution record with error if we have an executionId
    if (executionId) {
      try {
        await triggerStep({
          triggerData: {},
          _workflowComplete: {
            executionId,
            status: "error",
            error: errorMessage,
            startTime: Date.now(),
          },
        });
      } catch (logError) {
        logSystemError(
          ErrorCategory.INFRASTRUCTURE,
          "[Workflow Executor] Failed to log error:",
          logError,
          baseLogLabels
        );
      }
    }

    return {
      success: false,
      results,
      outputs,
      error: errorMessage,
    };
  } finally {
    if (executionId) {
      clearExecution(executionId);
    }
  }
}
