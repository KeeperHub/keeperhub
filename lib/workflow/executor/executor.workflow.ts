/**
 * Workflow-based executor using "use workflow" and "use step" directives
 * This executor captures step executions through the workflow SDK for better observability
 */

import {
  applyBigIntConversion,
  needsBigIntMode,
} from "@/lib/bigint-condition-utils";
import {
  ErrorCategory,
  logSystemError,
  logSystemWarn,
  logUserError,
  logWarn,
} from "@/lib/logging";
import { getMetricsCollector } from "@/lib/metrics";
import {
  decrementConcurrentExecutions,
  incrementConcurrentExecutions,
} from "@/lib/metrics/instrumentation/saturation";
import {
  detectTriggerType,
  recordWorkflowComplete,
} from "@/lib/metrics/instrumentation/workflow";
import { LabelKeys, MetricNames } from "@/lib/metrics/types";
import { scanAndReport } from "@/lib/security/content-scanner";
import {
  getActionLabel,
  getStepImporter,
  type StepImporter,
} from "@/lib/step-registry";
import { deserializeTriggerInput, getErrorMessageAsync } from "@/lib/utils";
import {
  BUILTIN_NODE_ID,
  BUILTIN_NODE_LABEL,
  getBuiltinVariables,
} from "@/lib/workflow/editor/builtin-variables";
import {
  buildEdgesBySourceHandle,
  type EdgesBySourceHandle,
} from "@/lib/workflow/editor/edge-handle-utils";
import {
  buildEdgesBySource,
  buildEdgesByTarget,
  getReadyDownstreamIds,
  propagateConvergenceSkips,
  signalConvergenceArrival,
} from "@/lib/workflow/executor/convergence-barrier";
import { mergeFromAuthority } from "@/lib/workflow/executor/convergence-tracker-merge";
import { enterWorkflowErrorContext } from "@/lib/workflow/executor/error-context";
import {
  computeFinalSuccess,
  type ExecutionResult,
  findOrphanedNodes,
} from "@/lib/workflow/executor/final-success";
import { runBodyNode } from "@/lib/workflow/executor/for-each-body-runner";
import {
  clearOutputCache,
  getCompletedStepOutput,
} from "@/lib/workflow/executor/get-completed-step-output";
import { awaitCompletedStepOutputStep } from "@/lib/workflow/executor/get-completed-step-output.step";
import { createPendingTracker } from "@/lib/workflow/executor/pending-tasks";
import {
  EXCEEDED_MAX_RETRIES_REGEX,
  FAILED_AFTER_RETRIES_REGEX,
  NO_STEP_COMPLETION_REGEX,
} from "@/lib/workflow/executor/runner-error-patterns";
import { reconcileSpuriousFailures } from "@/lib/workflow/executor/spurious-recovery";
import type { StepContext } from "@/lib/workflow/executor/step-handler";
import {
  clearExecution,
  getSuccessfulSteps,
} from "@/lib/workflow/executor/step-success-tracker";
import type { SystemActionType } from "@/lib/workflow/executor/system-action-types";
import {
  assertResolved,
  createTracker,
  recordUnresolved,
  TemplateResolutionError,
  type TemplateResolutionTracker,
} from "@/lib/workflow/executor/template-resolution";
import {
  isMissingReference,
  makeMissingReference,
} from "@/lib/workflow/nodes/condition/missing-reference";
import { resolveConditionExpression } from "@/lib/workflow/nodes/condition/resolver";
import { safeEvaluateCondition } from "@/lib/workflow/nodes/condition/safe-eval";
import {
  type ConditionDecision,
  collectSkippedTargets,
} from "@/lib/workflow/nodes/condition/skipped-branch";
import {
  preValidateConditionExpression,
  validateConditionExpression,
} from "@/lib/workflow/nodes/condition/validator";
import { ARRAY_SOURCE_RE } from "@/lib/workflow/nodes/for-each/utils";
import { triggerStep } from "@/lib/workflow/nodes/trigger/step";
import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow/store";
import { splitTemplateRef } from "@/lib/workflow/template-ref";
import { LEGACY_ACTION_MAPPINGS } from "@/plugins/legacy-mappings";

// System actions that don't have plugins - maps to module import functions.
// `satisfies Record<SystemActionType, ...>` makes the dispatch table and the
// egress classification map (lib/features/system-action-capabilities.ts) a
// compile-time mirror: a key here that is not in SystemActionType (or vice
// versa) fails the build, so a new system action cannot ship unclassified.
const SYSTEM_ACTIONS = {
  "Database Query": {
    importer: () =>
      // biome-ignore lint/suspicious/noExplicitAny: Dynamic module import
      import("@/lib/workflow/nodes/database-query/step") as Promise<any>,
    stepFunction: "databaseQueryStep",
  },
  "HTTP Request": {
    importer: () =>
      // biome-ignore lint/suspicious/noExplicitAny: Dynamic module import
      import("@/lib/workflow/nodes/http-request/step") as Promise<any>,
    stepFunction: "httpRequestStep",
  },
  Condition: {
    importer: () =>
      // biome-ignore lint/suspicious/noExplicitAny: Dynamic module import
      import("@/lib/workflow/nodes/condition/step") as Promise<any>,
    stepFunction: "conditionStep",
  },
  "For Each": {
    importer: () =>
      // biome-ignore lint/suspicious/noExplicitAny: Dynamic module import matches existing pattern
      import("@/lib/workflow/nodes/for-each/step") as Promise<any>,
    stepFunction: "forEachStep",
  },
  Collect: {
    importer: () =>
      // biome-ignore lint/suspicious/noExplicitAny: Dynamic module import matches existing pattern
      import("@/lib/workflow/nodes/collect/step") as Promise<any>,
    stepFunction: "collectStep",
  },
} satisfies Record<SystemActionType, StepImporter>;

export {
  computeFinalSuccess,
  type ExecutionResult,
} from "@/lib/workflow/executor/final-success";

type NodeOutputs = Record<string, { label: string; data: unknown }>;

/**
 * Catch-time write of a node's entry in the `outputs` map. Preserves a prior
 * non-null success when one exists; otherwise writes `{ label, data: null }`
 * so downstream resolvers see a sentinel rather than `undefined`.
 *
 * Rationale: the workflow SDK occasionally replays a step after its first
 * attempt has already populated `outputs[sanitizedNodeId]` with a successful
 * object (the post-step `step_completed` event is lost under heavy fan-in,
 * the same race covered by the spurious-max-retries reconciliation above).
 * Unconditionally overwriting that prior success with `data: null` caused
 * downstream templates to fail with `Node "X" produced no data.` This helper
 * keeps the catch handler's null-fallback contract for the no-prior-data case
 * while leaving real replay-survivor data intact.
 */
export function recordCatchOutput(
  outputs: NodeOutputs,
  sanitizedNodeId: string,
  label: string
): void {
  const prior = outputs[sanitizedNodeId];
  if (prior !== undefined && prior.data !== null && prior.data !== undefined) {
    return;
  }
  outputs[sanitizedNodeId] = { label, data: null };
}

/** Matches path segment like "carts[0]" for array index access (same as template.ts) */
const ARRAY_ACCESS_PATTERN = /^([^[]+)\[(\d+)\]$/;

/**
 * Render a resolved condition value for the logged input/output panels while
 * preserving the null/undefined distinction. `undefined` (e.g. a reference to a
 * branch node that never executed) is shown as the string "undefined" so it is
 * not mistaken for `null` -- `null` JSON-serializes fine and is left as-is, but
 * `undefined` would otherwise be dropped/collapsed and read as `null`, making a
 * strict `=== null` (isNull) check look like it should have matched. Recurses
 * through plain objects and arrays. Display-only; never fed back into eval.
 */
function formatConditionValueForDisplay(value: unknown): unknown {
  if (value === undefined || isMissingReference(value)) {
    return "undefined";
  }
  if (Array.isArray(value)) {
    return value.map(formatConditionValueForDisplay);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      out[key] = formatConditionValueForDisplay(nested);
    }
    return out;
  }
  return value;
}

/**
 * Spurious-max-retries recovery poll window. When the framework re-fires a
 * step after a lost completion event and throws before the step's success row
 * is committed, the real success lands ~0.3-0.5s later. The catch handler
 * polls the step authority for up to this window before falling back to
 * nullifying the node.
 */
const SPURIOUS_RECOVERY_POLL_TIMEOUT_MS = 3000;
const SPURIOUS_RECOVERY_POLL_INTERVAL_MS = 250;

/**
 * KEEP-398: SDK error shapes that indicate a spurious step-completion failure.
 *
 * Defined in runner-error-patterns.ts and re-exported here so the existing
 * unit test (executor-spurious-max-retries.test.ts) that imports from this
 * module continues to work without change.
 */
export {
  EXCEEDED_MAX_RETRIES_REGEX,
  FAILED_AFTER_RETRIES_REGEX,
  NO_STEP_COMPLETION_REGEX,
} from "@/lib/workflow/executor/runner-error-patterns";

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
  // Org plan ("free" | "pro" | "business" | "enterprise") used as a
  // low-cardinality label on error metrics so alerts can filter to managed
  // clients. Resolved by the caller via getOrgPlanLabel().
  organizationPlan?: string;
  createdBy?: string;
};

/**
 * Walk a field path that failed to resolve and describe where it broke, in the
 * same terms the resolver used to throw in. Returned to the caller so a
 * mistyped reference is reported on the condition's output instead of being
 * lost when the path resolves to undefined.
 */
function describeMissingFieldPath(data: unknown, fieldPath: string): string {
  let current: unknown = data;

  for (const segment of fieldPath.split(".")) {
    if (current === null || current === undefined) {
      return `"${fieldPath}" could not be resolved: "${segment}" was read from ${current === null ? "null" : "undefined"}.`;
    }
    if (typeof current !== "object") {
      return `"${fieldPath}" could not be resolved: "${segment}" was read from a ${typeof current}.`;
    }

    const container = current as Record<string, unknown>;
    const arrayMatch = segment.match(ARRAY_ACCESS_PATTERN);
    if (arrayMatch) {
      const [, key, indexStr] = arrayMatch;
      const index = Number.parseInt(indexStr, 10);
      if (!(key in container)) {
        return `"${fieldPath}": "${key}" does not exist on the data. Available fields: ${Object.keys(container).join(", ") || "(none)"}`;
      }
      const arr = container[key];
      if (!Array.isArray(arr)) {
        return `"${fieldPath}": "${key}" is not an array. Cannot access [${index}].`;
      }
      if (index < 0 || index >= arr.length) {
        return `"${fieldPath}": "${segment}" is out of range (array length ${arr.length}). Use index 0 to ${arr.length - 1}.`;
      }
      current = arr[index];
      continue;
    }

    if (!(segment in container)) {
      return `"${fieldPath}": "${segment}" does not exist on the data. Available fields: ${Object.keys(container).join(", ") || "(none)"}`;
    }
    current = container[segment];
  }

  return `"${fieldPath}" could not be resolved.`;
}

/**
 * Helper to replace template variables in conditions
 */
function replaceTemplateVariable(
  _match: string,
  nodeId: string,
  rest: string,
  outputs: NodeOutputs,
  evalContext: Record<string, unknown>,
  varCounter: { value: number },
  nodeMap?: ReadonlyMap<string, unknown>,
  executionResults?: Record<string, ExecutionResult>,
  unresolvedFields?: string[]
): string {
  const sanitizedNodeId = nodeId.replace(/[^a-zA-Z0-9]/g, "_");
  const output = outputs[sanitizedNodeId];

  // KEEP-1284: Throw error when referenced node output doesn't exist
  if (!output) {
    // Dead-branch grace: if the node exists in the workflow graph but was never
    // executed (it sits on a branch that a condition did not take), return
    // undefined instead of throwing so the condition evaluates gracefully.
    if (
      nodeMap?.has(nodeId) &&
      executionResults &&
      !(nodeId in executionResults)
    ) {
      const varName = `__v${varCounter.value}`;
      varCounter.value += 1;
      evalContext[varName] = undefined;
      return varName;
    }
    throw new Error(
      `Condition references node "${nodeId}" but no output was found. The referenced node may not have executed or produced output.`
    );
  }

  const { fieldPath } = splitTemplateRef(rest, output.label);
  let value: unknown;

  if (!fieldPath) {
    value = output.data;
  } else if (output.data === null || output.data === undefined) {
    // A node that produced no data is the same situation as a field that is
    // not there: bind undefined so a presence guard can handle it, and report
    // the path. Only a reference to a node with no output entry at all still
    // throws, since that is a broken reference rather than an empty result.
    const detail = `"${rest}": the node output data is ${output.data === null ? "null" : "undefined"}.`;
    unresolvedFields?.push(detail);
    value = makeMissingReference(detail);
  } else {
    // Wrapper-aware lookup: matches resolveFromOutputData's three-shape walk
    // (top-level → { data: ... } → { result: ... }) so paths like
    // "args.value" resolve through the trigger node's
    // { success: true, data: triggerData } wrapper -- the same unwrap that
    // action-config templates already get. Falls back to the strict inline
    // walk below for legitimate misses so the user still sees the existing
    // "Available fields" error against the top-level shape.
    const checked = resolveFromOutputDataChecked(output.data, fieldPath);
    if (checked.found) {
      const varName = `__v${varCounter.value}`;
      varCounter.value += 1;
      evalContext[varName] = checked.value;
      return varName;
    }

    // Absent path resolves to undefined rather than throwing. Every reference
    // in the expression is resolved before the expression runs, so throwing
    // here also defeats a guard the author wrote for exactly this case: in
    // `a !== undefined && a == b`, the `&&` never gets to short-circuit
    // because `a` is resolved before evaluation starts. The path is reported
    // on the step output so a mistyped field is still visible in the run.
    const detail = describeMissingFieldPath(output.data, fieldPath);
    unresolvedFields?.push(detail);
    value = makeMissingReference(detail);
  }

  const varName = `__v${varCounter.value}`;
  varCounter.value += 1;
  evalContext[varName] = value;
  return varName;
}

type ConditionEvalResult = {
  result: boolean;
  resolvedValues: Record<string, unknown>;
  // The expression with each {{...}} reference replaced by its resolved value,
  // so observability shows what was actually compared (e.g. "0x1..." == "0x6...").
  resolvedExpression?: string;
  // Field paths that were not present on their node's output and so resolved
  // to undefined. The branch is still taken on the evaluated result; this
  // carries the diagnostic so a mistyped path is visible in the run detail.
  unresolvedFields?: string[];
};

// Render a resolved value as it should appear inside the resolved expression:
// strings quoted, numbers/booleans/null bare, undefined as the keyword.
function renderConditionLiteral(value: unknown): string {
  if (value === undefined || isMissingReference(value)) {
    return "undefined";
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Evaluate condition expression with template variable replacement.
 *
 * Security (A-01): The transformed expression is evaluated by a safe AST
 * interpreter (safeEvaluateCondition) that never constructs functions and
 * never reaches host globals. It can only read the resolved __v/__b values and
 * apply an allowlisted set of operators and methods. Expressions are still
 * validated upfront for clear user-facing error messages.
 */
// Exported for testing - KEEP-1284
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
      const tokenLiterals: Record<string, string> = {};
      let transformedExpression = conditionExpression;
      const templatePattern = /\{\{@([^:]+):([^}]+)\}\}/g;
      const varCounter = { value: 0 };
      const unresolvedFields: string[] = [];

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
            executionResults,
            unresolvedFields
          );
          // Store the resolved value with a readable key (the display text
          // from the template), preserving the null/undefined distinction so a
          // strict `isNull` (=== null) check is not mistaken for a match.
          resolvedValues[rest] = formatConditionValueForDisplay(
            evalContext[varName]
          );
          tokenLiterals[match] = renderConditionLiteral(evalContext[varName]);
          return varName;
        }
      );

      // Mirror the substitution against the original expression so the value
      // side keeps the author's literals (quotes, operators) intact.
      const resolvedExpression = conditionExpression.replace(
        templatePattern,
        (match: string) => tokenLiterals[match] ?? match
      );

      // KEEP-468: any `{{...}}` token left after stored-format substitution
      // is either display-format (`{{Label.field}}`) or legacy `{{$nodeId}}`,
      // neither of which is supported in condition expressions. Without this
      // check the leftover token feeds into the JS evaluator below and surfaces
      // as a misleading "Unexpected token '{'" syntax error. Fail closed
      // explicitly with a clear message that points the author at the right
      // grammar.
      const leftoverTemplateMatches =
        transformedExpression.match(/\{\{[^}]+\}\}/g);
      if (leftoverTemplateMatches && leftoverTemplateMatches.length > 0) {
        throw new Error(
          `Condition contains unresolved template reference(s): ${[...new Set(leftoverTemplateMatches)].join(", ")}. Use stored format \`{{@nodeId:Label.field}}\` for condition references.`
        );
      }

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

      // Safe AST interpreter (no new Function / no host access) for A-01.
      // Only reads the resolved __v/__b values and applies allowlisted
      // operators and methods.
      const result = safeEvaluateCondition(transformedExpression, evalContext);
      if (unresolvedFields.length > 0) {
        logWarn("[Condition] Reference(s) resolved to undefined", {
          unresolved: unresolvedFields.join(" | "),
        });
      }
      return {
        result: Boolean(result),
        resolvedValues,
        resolvedExpression,
        ...(unresolvedFields.length > 0 ? { unresolvedFields } : {}),
      };
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

type StepFunction = (input: Record<string, unknown>) => Promise<unknown>;

/** Action type -> the step function to invoke for it. */
export type StepFunctionTable = ReadonlyMap<string, StepFunction>;

/** Resolve the importer for an action type, honoring legacy action renames. */
function findStepImporter(actionType: string): StepImporter | undefined {
  const systemAction = (SYSTEM_ACTIONS as Record<string, StepImporter>)[
    actionType
  ];
  if (systemAction) {
    return systemAction;
  }
  const direct = getStepImporter(actionType);
  if (direct) {
    return direct;
  }
  const mapped = LEGACY_ACTION_MAPPINGS[actionType];
  return mapped ? getStepImporter(mapped) : undefined;
}

/**
 * Resolve every step module the workflow can reach, before any step runs.
 *
 * Step identity in the durability layer is assigned by invocation order: the
 * Nth `useStep` call in a run gets the Nth id, with no name or content
 * matching. A replay therefore has to invoke steps in exactly the order the
 * event log recorded, or every id from the divergence point on refers to the
 * wrong step and the log becomes unreadable.
 *
 * `executeActionStep` used to `await importer()` immediately before calling the
 * step. That await put the step invocation into a racing microtask: on the
 * first pass the module load is real I/O, on a replay it is an already-resolved
 * cache hit, so N branches fanned out in parallel reach their step calls in
 * different orders on different passes. Resolving the modules here -- once, up
 * front, before any step is invoked -- leaves the fan-out path synchronous from
 * `executeNode` through to the step call, so invocation order follows the graph
 * instead of module-load timing.
 *
 * Iterating a sorted list keeps this preload itself order-stable. It invokes no
 * steps, so it contributes nothing to the event log.
 */
export async function preloadStepFunctions(
  nodes: WorkflowNode[]
): Promise<StepFunctionTable> {
  const actionTypes = new Set<string>();
  for (const node of nodes) {
    if (node.data.type !== "action") {
      continue;
    }
    const actionType = node.data.config?.actionType as string | undefined;
    if (actionType) {
      actionTypes.add(actionType);
    }
  }

  const table = new Map<string, StepFunction>();
  for (const actionType of [...actionTypes].sort()) {
    const importer = findStepImporter(actionType);
    if (!importer) {
      continue;
    }
    try {
      const module = await importer.importer();
      const stepFunction = module[importer.stepFunction];
      if (typeof stepFunction === "function") {
        table.set(actionType, stepFunction as StepFunction);
      }
    } catch (error) {
      // A module that fails to load here fails again at call time, where the
      // error is attributed to the node instead of aborting the whole run.
      logSystemError(
        ErrorCategory.WORKFLOW_ENGINE,
        "[Workflow Executor] Failed to preload step module",
        error instanceof Error ? error : new Error(String(error)),
        { action_type: actionType }
      );
    }
  }
  return table;
}

/**
 * Execute a single action step with logging via stepHandler
 * IMPORTANT: Steps receive only the integration ID as a reference to fetch credentials.
 * This prevents credentials from being logged in workflow observability output.
 */
async function executeActionStep(input: {
  actionType: string;
  config: Record<string, unknown>;
  outputs: NodeOutputs;
  context: StepContext;
  stepFunctions: StepFunctionTable;
  nodeMap?: ReadonlyMap<string, unknown>;
  executionResults?: Record<string, ExecutionResult>;
}) {
  const { actionType, config, outputs, context, stepFunctions } = input;

  // Build step input WITHOUT credentials, but WITH integrationId reference and logging context
  const stepInput: Record<string, unknown> = {
    ...config,
    _actionType: actionType,
    _context: context,
  };

  // Resolved by preloadStepFunctions before any step ran. Looking it up
  // synchronously is what keeps the step invocation in program order -- an
  // await here would hand the ordering back to microtask scheduling.
  const stepFunction = stepFunctions.get(actionType);
  if (!stepFunction) {
    return {
      success: false,
      error: `Unknown action type: "${actionType}". This action is not registered in the plugin system. Available system actions: ${Object.keys(SYSTEM_ACTIONS).join(", ")}.`,
    };
  }

  // Special handling for Condition action - needs template evaluation
  if (actionType === "Condition") {
    const originalExpression =
      resolveConditionExpression(stepInput) ?? stepInput.condition;

    // KEEP-1284: Catch evaluation errors and pass to step so it gets logged
    let evaluatedCondition = false;
    let resolvedValues: Record<string, unknown> = {};
    let resolvedExpression: string | undefined;
    let evaluationError: string | undefined;
    let unresolvedFields: string[] | undefined;

    try {
      const result = evaluateConditionExpression(
        originalExpression,
        outputs,
        input.nodeMap,
        input.executionResults
      );
      evaluatedCondition = result.result;
      resolvedValues = result.resolvedValues;
      resolvedExpression = result.resolvedExpression;
      unresolvedFields = result.unresolvedFields;
    } catch (error) {
      evaluationError = error instanceof Error ? error.message : String(error);
    }

    console.log("[Condition] Final result:", evaluatedCondition);

    return await stepFunction({
      condition: evaluatedCondition,
      // Include original expression only when evaluation succeeded (avoid raw template in UI on failure)
      expression:
        !evaluationError && typeof originalExpression === "string"
          ? originalExpression
          : undefined,
      resolvedExpression: evaluationError ? undefined : resolvedExpression,
      values:
        Object.keys(resolvedValues).length > 0 ? resolvedValues : undefined,
      _evaluationError: evaluationError,
      unresolvedFields,
      _context: context,
    });
  }

  return await stepFunction(stepInput);
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
    typeof (data as Record<string, unknown>).data === "object" &&
    (data as Record<string, unknown>).data !== null
  );
}

// KEEP-442: code/run-code wraps the user's return value in `.result` (the
// step output is `{ success, result, logs }`). Without this fallback, a
// downstream string field referencing `{{@prep:Prep.url}}` (where `prep`
// is a code/run-code that returned `{ url }`) resolves to "" because
// `data.url` is undefined and the existing `.data` fallback only matches
// the HTTP-style wrapper shape.
function hasNestedResultShape(
  data: unknown
): data is Record<string, unknown> & { result: object } {
  return (
    typeof data === "object" &&
    data !== null &&
    "result" in data &&
    typeof (data as Record<string, unknown>).result === "object" &&
    (data as Record<string, unknown>).result !== null
  );
}

/**
 * Resolve a field path from output data, transparently unwrapping common
 * step-result wrappers when the path doesn't match at the top level:
 *   - `{ data: ... }` (HTTP-style result)
 *   - `{ result: ... }` (code/run-code wrapper -- KEEP-442)
 */
export function resolveFromOutputData(
  data: unknown,
  fieldPath: string
): unknown {
  const fromTop = fieldPath ? resolveConfigFieldPath(data, fieldPath) : data;
  if (fromTop !== undefined && fromTop !== null) {
    return fromTop;
  }
  if (hasNestedDataShape(data)) {
    const inner = data.data;
    const fromInner = fieldPath
      ? resolveConfigFieldPath(inner, fieldPath)
      : inner;
    if (fromInner !== undefined && fromInner !== null) {
      return fromInner;
    }
  }
  if (hasNestedResultShape(data)) {
    const inner = data.result;
    return fieldPath ? resolveConfigFieldPath(inner, fieldPath) : inner;
  }
  return;
}

function replaceConfigTemplate(
  match: string,
  nodeId: string,
  rest: string,
  outputs: NodeOutputs,
  tracker?: TemplateResolutionTracker
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
    recordUnresolved(tracker, {
      token: match,
      reason: "no-node",
      detail: `Node "${trimmedNodeId}" has no output yet.`,
    });
    return "";
  }
  const data = output.data;
  if (data === null || data === undefined) {
    console.log(
      "[Template] Output data is null/undefined, returning empty string"
    );
    recordUnresolved(tracker, {
      token: match,
      reason: "no-data",
      detail: `Node "${trimmedNodeId}" produced no data.`,
    });
    return "";
  }

  const dataKeys =
    typeof data === "object" && data !== null
      ? Object.keys(data as Record<string, unknown>)
      : [];
  console.log("[Template] Output data top-level keys:", dataKeys);

  // Checked walk (the same one the Condition path uses) so a key that exists
  // but holds null/undefined resolves to that value. Inferring "missing" from a
  // nullish result conflated the two and failed the action on a path that was
  // present and legitimately empty.
  const checked = resolveFromOutputDataChecked(data, fieldPath);
  if (!checked.found) {
    if (hasNestedDataShape(data)) {
      const innerKeys = Object.keys(data.data as Record<string, unknown>);
      console.log("[Template] Trying inner output.data, keys:", innerKeys);
    }
    console.log(
      "[Template] Path not found, returning empty string. fieldPath:",
      fieldPath
    );
    recordUnresolved(tracker, {
      token: match,
      reason: "no-path",
      detail: `Field "${fieldPath || "(whole output)"}" not found on node "${trimmedNodeId}".`,
    });
    return "";
  }

  const resolved = checked.value;
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
 *
 * KEEP-468: optional `tracker` records every reference that fell through to
 * the empty-string or literal-pass-through path so the caller can fail
 * closed in strict mode.
 */
export function processTemplates(
  config: Record<string, unknown>,
  outputs: NodeOutputs,
  tracker?: TemplateResolutionTracker
): Record<string, unknown> {
  const processed: Record<string, unknown> = {};
  const storedPattern = /\{\{@([^:]+):([^}]+)\}\}/g;
  // Fallback: resolve display-format templates {{Label.field}} that were not
  // converted to stored format by the editor (mirrors extractTemplateParameters).
  const displayPattern = /\{\{([^@}][^}]*)\}\}/g;

  for (const [key, value] of Object.entries(config)) {
    if (typeof value === "string") {
      let result = value.replace(storedPattern, (m, nodeId, rest) =>
        replaceConfigTemplate(m, nodeId, rest, outputs, tracker)
      );
      result = result.replace(displayPattern, (full, displayRef) => {
        const resolved = resolveDisplayTemplate(displayRef, outputs);
        if (resolved === null || resolved === undefined) {
          recordUnresolved(tracker, {
            token: full,
            reason: "no-path",
            detail: `Display reference "${displayRef}" did not resolve.`,
          });
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
        outputs,
        tracker
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
  if (typeof value === "bigint") {
    return `${value}n`;
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
// Character ranges [start, end) of `//` line comments and block comments in JS
// source. String/template literals are tracked so a `//` or `{{...}}` inside a
// string is NOT treated as a comment -- only genuine comments are returned.
function computeCommentRanges(code: string): [number, number][] {
  const ranges: [number, number][] = [];
  const n = code.length;
  let i = 0;
  let stringDelim: string | null = null;
  while (i < n) {
    const c = code[i];
    if (stringDelim) {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === stringDelim) {
        stringDelim = null;
      }
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      stringDelim = c;
      i++;
      continue;
    }
    if (c === "/" && code[i + 1] === "/") {
      const start = i;
      i += 2;
      while (i < n && code[i] !== "\n") {
        i++;
      }
      ranges.push([start, i]);
      continue;
    }
    if (c === "/" && code[i + 1] === "*") {
      const start = i;
      i += 2;
      while (i < n && !(code[i] === "*" && code[i + 1] === "/")) {
        i++;
      }
      i = Math.min(i + 2, n);
      ranges.push([start, i]);
      continue;
    }
    i++;
  }
  return ranges;
}

function offsetInRanges(offset: number, ranges: [number, number][]): boolean {
  return ranges.some(([start, end]) => offset >= start && offset < end);
}

function lineNumberAt(code: string, offset: number): number {
  let line = 1;
  const limit = Math.min(offset, code.length);
  for (let i = 0; i < limit; i++) {
    if (code[i] === "\n") {
      line++;
    }
  }
  return line;
}

function resolveStoredCodeRef(
  full: string,
  nodeId: string,
  rest: string,
  outputs: NodeOutputs,
  tracker: TemplateResolutionTracker | undefined,
  line: number
): string {
  const trimmedNodeId = nodeId.trim();
  const sanitizedNodeId = trimmedNodeId.replace(/[^a-zA-Z0-9]/g, "_");
  const output = outputs[sanitizedNodeId] ?? outputs[trimmedNodeId];
  if (!output) {
    recordUnresolved(tracker, {
      token: full,
      reason: "no-node",
      detail: `Node "${trimmedNodeId}" has no output yet (line ${line}).`,
    });
    return full;
  }
  const { data } = output;
  if (data === null || data === undefined) {
    recordUnresolved(tracker, {
      token: full,
      reason: "no-data",
      detail: `Node "${trimmedNodeId}" produced no data (line ${line}).`,
    });
    return "null";
  }
  const fieldPath = rest.includes(".")
    ? rest.substring(rest.indexOf(".") + 1).trim()
    : "";
  // Checked walk: a key that exists holding null/undefined is a real value and
  // renders as the `null` literal, not an unresolved reference.
  const checked = resolveFromOutputDataChecked(data, fieldPath);
  if (!checked.found) {
    recordUnresolved(tracker, {
      token: full,
      reason: "no-path",
      detail: `Field "${fieldPath || "(whole output)"}" not found on node "${trimmedNodeId}" (line ${line}).`,
    });
    return "null";
  }
  return formatCodeValue(checked.value);
}

function resolveDisplayCodeRef(
  full: string,
  displayRef: string,
  outputs: NodeOutputs,
  tracker: TemplateResolutionTracker | undefined,
  line: number
): string {
  const resolved = resolveDisplayTemplate(displayRef, outputs);
  if (resolved === undefined || resolved === null) {
    recordUnresolved(tracker, {
      token: full,
      reason: "no-path",
      detail: `Display reference "${displayRef}" did not resolve (line ${line}).`,
    });
    return "null";
  }
  return formatCodeValue(resolved);
}

// Matches a stored ref `{{@nodeId:Label.field}}` OR a display ref
// `{{Label.field}}` in one pass so offsets align with the comment scan below.
const CODE_TEMPLATE_PATTERN = /\{\{@([^:]+):([^}]+)\}\}|\{\{([^@}][^}]*)\}\}/g;

export function processCodeTemplates(
  code: string,
  outputs: NodeOutputs,
  tracker?: TemplateResolutionTracker
): string {
  // Refs inside comments or commented-out code are documentation, not
  // dependencies: they must not be resolved or fail strict resolution. Scan the
  // original code so match offsets line up with the comment ranges.
  const commentRanges = computeCommentRanges(code);

  return code.replace(
    CODE_TEMPLATE_PATTERN,
    (
      full: string,
      storedNodeId: string | undefined,
      storedRest: string | undefined,
      displayRef: string | undefined,
      offset: number
    ) => {
      if (offsetInRanges(offset, commentRanges)) {
        return full;
      }
      const line = lineNumberAt(code, offset);
      if (storedNodeId !== undefined && storedRest !== undefined) {
        return resolveStoredCodeRef(
          full,
          storedNodeId,
          storedRest,
          outputs,
          tracker,
          line
        );
      }
      if (displayRef !== undefined) {
        return resolveDisplayCodeRef(full, displayRef, outputs, tracker, line);
      }
      return full;
    }
  );
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
  const checked = resolveDisplayTemplateChecked(displayRef, outputs);
  return checked.found ? (checked.value ?? null) : null;
}

/**
 * Discriminated variant of `resolveDisplayTemplate`. Same back-compat
 * trade-off as `resolveTemplateToRawValueChecked`: legitimate `null`
 * upstream values must not look like an unresolved reference to strict-mode
 * callers.
 */
export function resolveDisplayTemplateChecked(
  displayRef: string,
  outputs: NodeOutputs
): RawValueResolution {
  const dotIndex = displayRef.indexOf(".");
  const label =
    dotIndex === -1 ? displayRef : displayRef.substring(0, dotIndex);
  const fieldPath = dotIndex === -1 ? "" : displayRef.substring(dotIndex + 1);

  const entry = findOutputByLabel(label, outputs);
  if (!entry) {
    return { found: false, reason: "no-node" };
  }

  if (entry.data === null || entry.data === undefined) {
    return { found: false, reason: "no-data" };
  }

  return resolveFromOutputDataChecked(entry.data, fieldPath);
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
  outputs: NodeOutputs,
  tracker?: TemplateResolutionTracker
): { parameterizedQuery: string; paramValues: unknown[] } {
  const paramValues: unknown[] = [];
  let paramIndex = 0;

  const replaceStored = (
    match: string,
    nodeId: string,
    rest: string
  ): string => {
    paramIndex++;
    const checked = resolveTemplateToRawValueChecked(nodeId, rest, outputs);
    if (checked.found) {
      // Legitimate values pass through, including upstream `null` (KEEP-468
      // edge case: a SQL column that genuinely returned NULL must not
      // false-trigger the strict gate).
      paramValues.push(checked.value);
    } else {
      recordUnresolved(tracker, {
        token: match,
        reason: checked.reason,
        detail: `Reference for node "${nodeId.trim()}" did not resolve (${checked.reason}).`,
      });
      paramValues.push(null);
    }
    return `$${paramIndex}`;
  };

  const replaceDisplay = (match: string, displayRef: string): string => {
    paramIndex++;
    const checked = resolveDisplayTemplateChecked(displayRef, outputs);
    if (checked.found) {
      paramValues.push(checked.value);
    } else {
      recordUnresolved(tracker, {
        token: match,
        reason: checked.reason,
        detail: `Display reference "${displayRef}" did not resolve (${checked.reason}).`,
      });
      paramValues.push(null);
    }
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
  const checked = resolveTemplateToRawValueChecked(nodeId, rest, outputs);
  return checked.found ? (checked.value ?? null) : null;
}

/**
 * Discriminated variant of `resolveTemplateToRawValue`. Lets the SQL
 * parameterizer (and any other strict-mode caller) distinguish "the
 * reference truly did not resolve" from "the reference resolved cleanly to
 * a legitimate null upstream value." The unwrapped helper above collapses
 * both cases to `null` for back-compat with For Each and tests.
 *
 * - `{ found: true, value }`   — node + path located. `value` may be `null`.
 * - `{ found: false, reason }` — `no-node`, `no-data`, or `no-path`.
 */
type RawValueResolution =
  | { found: true; value: unknown }
  | { found: false; reason: "no-node" | "no-data" | "no-path" };

/**
 * Walk a field path while preserving the difference between "the leaf key
 * exists and is null" and "the leaf key doesn't exist." The discriminator is
 * `'key' in obj`, which is true for properties whose value is null/undefined
 * but false when the property is absent. `resolveFromOutputData` collapses
 * both to `undefined`, which is fine for string substitution but loses the
 * signal strict-mode callers need.
 */
function resolveStrictPath(
  data: unknown,
  fieldPath: string
): RawValueResolution {
  if (!fieldPath) {
    return { found: true, value: data };
  }
  if (data === null || data === undefined) {
    return { found: false, reason: "no-path" };
  }
  let current: unknown = data;
  for (const part of fieldPath.split(".")) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }
    const arrayMatch = trimmed.match(ARRAY_ACCESS_PATTERN);
    if (arrayMatch) {
      const [, key, indexStr] = arrayMatch;
      if (
        current === null ||
        current === undefined ||
        typeof current !== "object"
      ) {
        return { found: false, reason: "no-path" };
      }
      const obj = current as Record<string, unknown>;
      if (!(key in obj)) {
        return { found: false, reason: "no-path" };
      }
      const arr = obj[key];
      if (!Array.isArray(arr)) {
        return { found: false, reason: "no-path" };
      }
      const idx = Number.parseInt(indexStr, 10);
      if (idx < 0 || idx >= arr.length) {
        return { found: false, reason: "no-path" };
      }
      current = arr[idx];
      continue;
    }
    if (
      current === null ||
      current === undefined ||
      typeof current !== "object"
    ) {
      return { found: false, reason: "no-path" };
    }
    const obj = current as Record<string, unknown>;
    if (!(trimmed in obj)) {
      return { found: false, reason: "no-path" };
    }
    current = obj[trimmed];
  }
  return { found: true, value: current };
}

/**
 * Strict-mode field-path resolution that mirrors `resolveFromOutputData`'s
 * three-shape lookup (top-level → `.data` wrapper → `.result` wrapper). The
 * shapes are tried in order; the first one whose path exists wins.
 */
function resolveFromOutputDataChecked(
  data: unknown,
  fieldPath: string
): RawValueResolution {
  const top = resolveStrictPath(data, fieldPath);
  if (top.found) {
    return top;
  }
  if (hasNestedDataShape(data)) {
    const inner = resolveStrictPath(data.data, fieldPath);
    if (inner.found) {
      return inner;
    }
  }
  if (hasNestedResultShape(data)) {
    const inner = resolveStrictPath(data.result, fieldPath);
    if (inner.found) {
      return inner;
    }
  }
  return { found: false, reason: "no-path" };
}

export function resolveTemplateToRawValueChecked(
  nodeId: string,
  rest: string,
  outputs: NodeOutputs
): RawValueResolution {
  const trimmedNodeId = nodeId.trim();
  const sanitizedNodeId = trimmedNodeId.replace(/[^a-zA-Z0-9]/g, "_");
  const output = outputs[sanitizedNodeId] ?? outputs[trimmedNodeId];
  const fieldPath = rest.includes(".")
    ? rest.substring(rest.indexOf(".") + 1).trim()
    : "";

  const resolvedOutput = output ?? findOutputByLabelFallback(rest, outputs);

  if (!resolvedOutput) {
    return { found: false, reason: "no-node" };
  }

  const data = resolvedOutput.data;
  if (data === null || data === undefined) {
    return { found: false, reason: "no-data" };
  }

  return resolveFromOutputDataChecked(data, fieldPath);
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
  /**
   * In-body Collect node found via depth-0 boundary BFS. Set in legacy graphs
   * (Collect placed in the body chain) and may also be set for transitional
   * graphs that have BOTH an in-body Collect and a done-handle Collect; in the
   * latter case the executor prefers `doneCollectNodeId`.
   */
  collectNodeId: string | undefined;
  /**
   * Entry points for the For Each's `done` sourceHandle. These run once after
   * the iteration loop completes (JS-equivalent: the line after `for (...) {}`).
   * Non-Collect targets execute as ordinary steps; a Collect target receives
   * the aggregated `{ results, count }` payload.
   */
  doneEntryNodeIds: string[];
  /**
   * If the canonical `done`-handle wiring routes to a Collect node, this is
   * its node ID. The executor prefers this over `collectNodeId` so workflows
   * that wire both are unambiguous.
   */
  doneCollectNodeId: string | undefined;
  bodyEdgesBySource: Map<string, string[]>;
  bodyEdgesBySourceHandle: EdgesBySourceHandle;
};

/**
 * Determine which downstream node IDs a condition node should dispatch to
 * within a For Each body. Mirrors the two-phase routing in executeBodyNode:
 *
 * 1. If the node has handle-based edges (bodyHandleMap entry), route
 *    exclusively via the taken handle. The not-taken handle is dead.
 * 2. Otherwise (legacy edges without sourceHandle), gate on conditionValue:
 *    true -> all bodyEdgesBySource targets, false -> nothing.
 *
 * Extracted so the routing decision is testable independently of the
 * async executeBodyNode closure.
 */
export function resolveBodyConditionTargets(
  conditionValue: boolean,
  nodeId: string,
  bodyHandleMap: EdgesBySourceHandle | undefined,
  bodyEdgesBySource: Map<string, string[]>
): string[] {
  const nodeHandles = bodyHandleMap?.get(nodeId);

  if (nodeHandles) {
    const handleId = conditionValue === true ? "true" : "false";
    return nodeHandles.get(handleId) ?? [];
  }

  // Legacy fallback: no handle map entry, gate on condition value
  if (conditionValue !== true) {
    return [];
  }

  return bodyEdgesBySource.get(nodeId) ?? [];
}

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
 * Pick the next-target list for a node visited inside a For Each body BFS.
 *
 * For nested For Each nodes that themselves expose `loop`/`done` handles, the
 * outer body resumes at the inner `done` chain (the inner loop body is the
 * inner For Each's own concern, not the outer's). For every other node — and
 * for legacy nested For Each nodes with no sourceHandle on their outgoing
 * edges — fall through to the handle-agnostic `edgesBySource` map; the depth
 * counter handles the legacy in-body Collect boundary case.
 */
function nextBodyTargets(
  nodeId: string,
  isForEach: boolean,
  edgesBySource: Map<string, string[]>,
  edgesBySourceHandle: EdgesBySourceHandle | undefined
): string[] {
  if (isForEach) {
    const handles = edgesBySourceHandle?.get(nodeId);
    const loopTargets = handles?.get("loop") ?? [];
    const doneTargets = handles?.get("done") ?? [];
    if (loopTargets.length > 0 || doneTargets.length > 0) {
      return doneTargets;
    }
  }
  return edgesBySource.get(nodeId) ?? [];
}

/**
 * Identify the loop body subgraph between a For Each node and its paired
 * Collect node.
 *
 * Two modes:
 *
 * 1. **Handle-aware** (canonical): the For Each has at least one outgoing
 *    edge with a `loop` or `done` sourceHandle. Body BFS seeds from the
 *    `loop` targets only; `done` targets become `doneEntryNodeIds` and run
 *    once the iteration loop finishes. If the first done target is a Collect
 *    node, it is recorded as `doneCollectNodeId` (the executor will hand it
 *    the aggregated `{ results, count }` payload).
 *
 * 2. **Legacy**: the For Each has no sourceHandle on any outgoing edge. Body
 *    BFS seeds from every outgoing edge (current pre-handle behavior) and
 *    terminates at the first depth-0 Collect, which becomes `collectNodeId`.
 *
 * In both modes the BFS uses depth tracking so nested For Each / Collect
 * pairs are correctly stepped over.
 */
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

  // Determine seeding strategy. Handle-aware mode kicks in as soon as any
  // outgoing edge from this For Each carries a sourceHandle, so a workflow
  // can opt in incrementally without changing legacy edges elsewhere.
  const handleMap = edgesBySourceHandle?.get(forEachNodeId);
  const loopTargets = handleMap?.get("loop") ?? [];
  const doneTargets = handleMap?.get("done") ?? [];
  const isHandleAware = loopTargets.length > 0 || doneTargets.length > 0;
  const seedTargets = isHandleAware
    ? loopTargets
    : (edgesBySource.get(forEachNodeId) ?? []);

  for (const targetId of seedTargets) {
    if (!bodyEdgesBySource.has(forEachNodeId)) {
      bodyEdgesBySource.set(forEachNodeId, []);
    }
    bodyEdgesBySource.get(forEachNodeId)?.push(targetId);
  }

  const queue: Array<{ nodeId: string; depth: number }> = seedTargets.map(
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

    // Collect at depth 0 is the legacy in-body boundary. In handle-aware
    // graphs this still terminates the body BFS; the executor decides at
    // post-iteration time whether to fire the in-body Collect (legacy) or
    // the done-handle Collect (canonical).
    if (isCollect && depth === 0) {
      if (collectNodeId && collectNodeId !== nodeId) {
        throw new Error(
          "For Each node has multiple in-body Collect nodes at the same " +
            "nesting level. Wire the Collect to the For Each's `done` " +
            "sourceHandle (canonical) or keep exactly one in-body Collect."
        );
      }
      collectNodeId = nodeId;
      continue;
    }

    bodyNodeIds.push(nodeId);

    const nextDepth = computeNextDepth(isForEach, isCollect, depth);
    const nextIds = nextBodyTargets(
      nodeId,
      isForEach,
      edgesBySource,
      edgesBySourceHandle
    );
    for (const nextId of nextIds) {
      if (!bodyEdgesBySource.has(nodeId)) {
        bodyEdgesBySource.set(nodeId, []);
      }
      bodyEdgesBySource.get(nodeId)?.push(nextId);
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

  // Resolve the canonical post-loop Collect: the first `done`-handle target
  // whose actionType is Collect. Non-Collect done targets remain in
  // `doneEntryNodeIds` and run as ordinary steps after the iteration loop.
  let doneCollectNodeId: string | undefined;
  for (const targetId of doneTargets) {
    const target = nodeMap.get(targetId);
    if (
      target?.data.type === "action" &&
      target.data.config?.actionType === "Collect"
    ) {
      doneCollectNodeId = targetId;
      break;
    }
  }

  return {
    bodyNodeIds,
    collectNodeId,
    doneEntryNodeIds: doneTargets,
    doneCollectNodeId,
    bodyEdgesBySource,
    bodyEdgesBySourceHandle,
  };
}

/**
 * Pick the edge map a nested For Each's body scan must run against: always
 * the workflow-global map, never the outer loop's `bodyEdgesBySource`. Why
 * the outer map is wrong is recorded at the `identifyLoopBody` call inside
 * `handleForEachExecution`, where the executor makes that choice inline.
 *
 * Nothing in the executor calls this function, so it is off that path. It
 * still takes both maps so the tests can state the choice explicitly,
 * naming the map that is rejected rather than asserting its absence.
 */
export function resolveNestedForEachEdgeMap(maps: {
  globalEdgesBySource: Map<string, string[]>;
  outerBodyEdgesBySource: Map<string, string[]>;
}): Map<string, string[]> {
  return maps.globalEdgesBySource;
}

/**
 * Decision about how a For Each should hand control off after its iteration
 * loop completes. Three shapes:
 *
 *   - `aggregate-collect`: a Collect node receives `{ results, count }` and
 *      the chain past it runs. Used for both the canonical done-handle
 *      Collect and the legacy in-body Collect; the canonical one wins when
 *      both are present.
 *   - `done-targets`: the For Each's done-handle wires to one or more
 *      non-Collect nodes; they run as ordinary post-loop steps with no
 *      aggregation injection.
 *   - `none`: fire-and-forget loop, nothing to dispatch.
 */
export type IterationContinuation =
  | { kind: "aggregate-collect"; collectNodeId: string }
  | { kind: "done-targets"; targets: string[] }
  | { kind: "none" };

/**
 * Pick the post-iteration continuation given the For Each's `LoopBodyInfo`.
 * Pure function so the routing priority is testable in isolation from the
 * surrounding step-firing / output-writing side effects.
 */
export function planIterationContinuation(
  body: Pick<
    LoopBodyInfo,
    "collectNodeId" | "doneCollectNodeId" | "doneEntryNodeIds"
  >
): IterationContinuation {
  const aggregate = body.doneCollectNodeId ?? body.collectNodeId;
  if (aggregate) {
    return { kind: "aggregate-collect", collectNodeId: aggregate };
  }
  if (body.doneEntryNodeIds.length > 0) {
    return { kind: "done-targets", targets: body.doneEntryNodeIds };
  }
  return { kind: "none" };
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
    organizationPlan,
    createdBy,
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
    ...(organizationPlan ? { plan: organizationPlan } : {}),
    ...(organizationName ? { org_name: organizationName } : {}),
    ...(createdBy ? { owner_id: createdBy } : {}),
  };

  // Enter async-local context so any logUserError/logSystemError called from
  // this point on (including inside plugin steps) automatically includes
  // org/owner/workflow identifiers without manual threading.
  enterWorkflowErrorContext({
    workflow_id: workflowId,
    execution_id: executionId,
    org_id: organizationId,
    org_slug: organizationSlug,
    plan: organizationPlan,
    owner_id: createdBy,
  });

  // KEEP-612 detection signal. Single pass at run start covering both
  // the static node configs and the runtime trigger payload, so an
  // attacker who injects a pattern via webhook body or scheduled trigger
  // input is caught at the boundary -- not just authors who bake the
  // patterns into config. Emits one Sentry + structured-stdout event
  // per execution. Alert-only -- never blocks.
  scanAndReport(
    { nodes, triggerInput },
    {
      workflowId,
      executionId,
      organizationId,
    }
  );

  const outputs: NodeOutputs = {};
  const results: Record<string, ExecutionResult> = {};

  // KEEP-395 (Bug 2): track every in-flight Promise.allSettled that
  // schedules executeNode calls, so we can drain orphaned downstream
  // branches before finalisation. The SDK's checkpoint resume can truncate
  // the call-stack-await chain inside executeReadyDownstream recursion;
  // wrapping every settle in `pendingTasks.track(...)` and draining at the
  // end ensures we never finalise before downstream nodes have run.
  const pendingTasks = createPendingTracker();

  // KEEP-395 observability: in a multi-process / multi-pod world the
  // step-success-tracker is in-process only. If a convergence node executes
  // on a pod that did not run its predecessors, getSuccessfulSteps returns
  // undefined and the merge-from-tracker silently degrades to closure
  // outputs (which may carry the staleness this fix exists to prevent).
  // Emit a one-time per-execution warning when that happens so prod logs
  // surface the degradation. Set membership prevents log spam.
  const warnedDegradationConvergenceIds = new Set<string>();

  // Build node and edge maps
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const edgesBySource = buildEdgesBySource(edges);
  const edgesBySourceHandle = buildEdgesBySourceHandle(edges);
  const conditionDecisions = new Map<string, ConditionDecision>();

  const edgesByTarget = buildEdgesByTarget(edges);
  const convergenceArrivals = new Map<string, Set<string>>();
  // Skip-arrivals tracked apart from real arrivals so an OR-join whose every
  // incoming edge was skipped is itself skipped rather than executed.
  const convergenceSkipArrivals = new Map<string, Set<string>>();
  // Nodes determined to be genuinely skipped (all incoming paths not taken).
  // Authoritative input to computeFinalSuccess so a node that actually executed
  // and failed is never masked as skipped.
  const skippedNodes = new Set<string>();

  // Every node executeNode was entered for, across all branches. The per-branch
  // `visited` sets cannot answer "was this node ever reached" on their own, and
  // `results` misses disabled nodes (which return before recording one), so
  // orphan detection needs its own run-wide record.
  const attemptedNodes = new Set<string>();

  // Nodes whose execution is gated by a condition's routing decision, excluded
  // from orphan detection.
  const conditionNodeIds = new Set(
    nodes
      .filter(
        (n) =>
          n.data.type === "action" && n.data.config?.actionType === "Condition"
      )
      .map((n) => n.id)
  );

  // For Each body nodes run through runBodyNode, not executeNode, so they never
  // reach attemptedNodes and would otherwise all read as orphans. Their failures
  // are already accounted for by the For Each node's failedIterations.
  const loopBodyNodeIds = new Set<string>();
  for (const node of nodes) {
    if (
      node.data.type !== "action" ||
      node.data.config?.actionType !== "For Each"
    ) {
      continue;
    }
    const body = identifyLoopBody(
      node.id,
      edgesBySource,
      nodeMap,
      edgesBySourceHandle
    );
    for (const bodyNodeId of body.bodyNodeIds) {
      loopBodyNodeIds.add(bodyNodeId);
    }
    if (body.collectNodeId) {
      loopBodyNodeIds.add(body.collectNodeId);
    }
  }

  // Must complete before the first step runs: it invokes no steps itself, and
  // once it has, every step call downstream is reached synchronously, so the
  // order they are invoked in follows the graph rather than module-load timing.
  const stepFunctions = await preloadStepFunctions(nodes);

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
    currentOutputs: NodeOutputs,
    assertContext?: { nodeId?: string; nodeLabel?: string }
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

    // KEEP-468: collect every unresolved reference so we can fail closed
    // before the step runs. Tracker entries cover empty-string substitutions
    // (no-node / no-data / no-path); the post-scan inside `assertResolved`
    // catches the displayPattern literal-passthrough path.
    const tracker = createTracker();

    const processedConfig = processTemplates(
      configWithoutSpecial,
      currentOutputs,
      tracker
    );

    if (
      actionType === "Database Query" &&
      typeof originalDbQuery === "string"
    ) {
      const { parameterizedQuery, paramValues } = extractTemplateParameters(
        originalDbQuery,
        currentOutputs,
        tracker
      );
      processedConfig.dbQuery = parameterizedQuery;
      processedConfig._dbParams = paramValues;
    } else if (
      actionType === "Database Query" &&
      originalDbQuery !== undefined
    ) {
      processedConfig.dbQuery = originalDbQuery;
    }

    // Render the code now (so genuine unresolved refs in executable code land
    // in the tracker), but attach it only AFTER the leftover-literal assert
    // below. processCodeTemplates skips refs inside comments / commented-out
    // code, so the rendered code must stay out of the generic leftover scan --
    // otherwise a `{{...}}` left intact inside a comment would be re-flagged as
    // an unresolved literal. The tracker is the authority for code-field refs.
    let renderedCode: string | undefined;
    if (actionType === "code/run-code" && typeof originalCode === "string") {
      renderedCode = processCodeTemplates(
        originalCode,
        currentOutputs,
        tracker
      );
    }

    // KEEP-468 hotfix: scan + assert BEFORE re-attaching condition fields.
    // Condition expressions own their template resolution path
    // (`evaluateConditionExpression`, which has its own leftover-token gate
    // since b3d5d9eb), so the action-level scan must not see those tokens —
    // otherwise every Condition node downstream of For Each / a Code step
    // false-flags `{{@nodeId:Label.field}}` as a leftover literal and the
    // workflow body cannot run.
    assertResolved(tracker, processedConfig, {
      nodeId: assertContext?.nodeId,
      nodeLabel: assertContext?.nodeLabel,
      actionType,
    });

    if (renderedCode !== undefined) {
      processedConfig.code = renderedCode;
    }
    if (originalCondition !== undefined) {
      processedConfig.condition = originalCondition;
    }
    if (originalConditionConfig !== undefined) {
      processedConfig.conditionConfig = originalConditionConfig;
    }

    return processedConfig;
  }

  // -------------------------------------------------------------------
  // For Each: body-node executor (scoped outputs, body-only edges)
  // -------------------------------------------------------------------

  /**
   * Execute a single body node within a For Each iteration. Thin wrapper
   * around `runBodyNode` (extracted to lib/workflow/executor/for-each-body-runner.ts)
   * that captures the executor's closures (nodeMap, processActionConfig,
   * executeActionStep, etc.) into a `RunBodyContext`.
   *
   * The recursion logic itself lives in the pure runner so it can be
   * exercised directly in unit tests with a mocked step runner.
   */
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
    await runBodyNode(nodeId, {
      nodeMap,
      bodyEdgesBySource,
      bodyEdgesBySourceHandle: bodyHandleMap,
      collectNodeId,
      bodyVisited,
      bodyResults,
      scopedOutputs,
      iterationMeta,
      processConfig: processActionConfig,
      getNodeName,
      getErrorMessageAsync,
      injectBuiltinVariables: (outputs) => {
        const builtinSanitized = BUILTIN_NODE_ID.replace(/[^a-zA-Z0-9]/g, "_");
        outputs[builtinSanitized] = {
          label: BUILTIN_NODE_LABEL,
          data: getBuiltinVariables(),
        };
      },
      baseStepContext: {
        executionId,
        organizationId,
        orgSlug: organizationSlug,
        createdBy,
        workflowId,
      },
      runStep: async ({
        actionType,
        processedConfig,
        scopedOutputs: outputs,
        stepContext,
      }) =>
        // Pass nodeMap + executionResults so a Condition inside the loop body
        // gets the same dead-branch grace as a top-level Condition: a reference
        // to a graph node that never executed (e.g. a convergence node that
        // joins two mutually-exclusive branches) resolves to `undefined`
        // instead of throwing, letting `doesNotExist`/`=== undefined` rules
        // evaluate. Without this the body Condition fails closed with
        // "references node ... but no output was found".
        await executeActionStep({
          actionType,
          config: processedConfig,
          outputs,
          context: stepContext,
          stepFunctions,
          nodeMap,
          executionResults: results,
        }),
      // KEEP-543: Same KEEP-398/431 spurious-max-retries recovery pattern as
      // the top-level node executor, scoped to the current iteration.
      // getCompletedStepOutput is iteration-aware via the iterationKey arg:
      // tracker is keyed on (nodeId, forEachNodeId, iterationIndex), and the
      // DB fallback hits an iteration-scoped query that no longer filters
      // forEach rows out. Returning null falls through to the standard
      // failure path (the throw was real, not spurious).
      resolveSpuriousRecovery: executionId
        ? async ({ nodeId: bodyNodeId, iterationMeta: meta }) => {
            const recovered = await getCompletedStepOutput(
              executionId,
              bodyNodeId,
              {
                forEachNodeId: meta.forEachNodeId,
                iterationIndex: meta.iterationIndex,
              }
            );
            return recovered ? { output: recovered.output } : null;
          }
        : undefined,
      onSpuriousRecovery: ({
        nodeId: bodyNodeId,
        iterationMeta: meta,
        reason,
      }) => {
        getMetricsCollector().incrementCounter(
          "workflow.executor.spurious_recovery.total",
          {
            source: "body_runner",
            recovery_reason: reason,
            ...(workflowId ? { [LabelKeys.WORKFLOW_ID]: workflowId } : {}),
            ...(organizationId ? { [LabelKeys.ORG_ID]: organizationId } : {}),
            ...(organizationPlan ? { [LabelKeys.PLAN]: organizationPlan } : {}),
            for_each_node_id: meta.forEachNodeId,
            body_node_id: bodyNodeId,
          }
        );
      },
      handleNestedForEach: async ({
        forEachNodeId: nestedForEachNodeId,
        forEachNode: nestedForEachNode,
        processedConfig,
      }) => {
        await handleForEachExecution({
          forEachNodeId: nestedForEachNodeId,
          forEachNode: nestedForEachNode,
          processedConfig,
          currentOutputs: scopedOutputs,
          currentResults: bodyResults,
          currentVisited: bodyVisited,
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
          continueWithDoneTargets: async (_fromNodeId, targets) => {
            for (const next of targets) {
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
      },
    });
  }

  // -------------------------------------------------------------------
  // For Each: iteration orchestrator
  // -------------------------------------------------------------------

  async function handleForEachExecution(params: {
    forEachNodeId: string;
    forEachNode: WorkflowNode;
    processedConfig: Record<string, unknown>;
    currentOutputs: NodeOutputs;
    currentResults: Record<string, ExecutionResult>;
    currentVisited: Set<string>;
    /**
     * Dispatch downstream of a Collect node once iterations finish. Used for
     * both the canonical `done`-handle Collect and legacy in-body Collect.
     */
    continueAfterCollect?: (collectNodeId: string) => Promise<void>;
    /**
     * Dispatch the For Each's `done`-handle targets directly when none of
     * them is a Collect (i.e. the post-loop chain is just ordinary steps).
     */
    continueWithDoneTargets?: (
      fromNodeId: string,
      targets: string[]
    ) => Promise<void>;
  }): Promise<{
    arrayLength: number;
    maxIterations: number;
    iterationsRan: number;
    failedIterations: number;
    firstFailureError?: string;
    firstFailureNodeId?: string;
  }> {
    const {
      forEachNodeId,
      forEachNode,
      processedConfig,
      currentOutputs,
      currentResults,
      currentVisited,
      continueAfterCollect,
      continueWithDoneTargets,
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
    //
    // An outer loop's BFS stops at a handle-aware nested For Each and never
    // descends into the inner `loop` branch, so an outer `bodyEdgesBySource`
    // has no entry for edges living purely inside the inner body; passing one
    // here leaves every inner body node dangling at its seed, which is issue
    // #2049: the inner Condition never ran. The nested scan therefore runs
    // against the workflow-global `edgesBySource`.
    const {
      bodyNodeIds,
      collectNodeId,
      doneEntryNodeIds,
      doneCollectNodeId,
      bodyEdgesBySource,
      bodyEdgesBySourceHandle,
    } = identifyLoopBody(
      forEachNodeId,
      edgesBySource,
      nodeMap,
      edgesBySourceHandle
    );

    // Routing priority for the post-iteration continuation. Extracted as a
    // pure function so the canonical-vs-legacy precedence is testable in
    // isolation. See `planIterationContinuation` above.
    const continuation = planIterationContinuation({
      collectNodeId,
      doneCollectNodeId,
      doneEntryNodeIds,
    });
    // Source for the iteration-capture pass below. Iteration output is
    // whichever body node feeds INTO this Collect (legacy in-body Collect),
    // or — for the canonical done-handle pattern — the natural end of the
    // body chain (handled by the existing fallback).
    const captureCollectNodeId = collectNodeId;

    const sanitizedForEachId = forEachNodeId.replace(/[^a-zA-Z0-9]/g, "_");

    // 3. Single iteration executor
    const mapExpression = processedConfig.mapExpression as string | undefined;

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

      // Parallel For Each iterations are vulnerable to the same SDK
      // checkpoint-resume truncation that KEEP-395 fixed for the main
      // DAG. Without a strong reference, an iteration's recurseInto chain
      // (e.g., decode-network -> HTTP Request) can be severed after the
      // first step's checkpoint, leaving the downstream step unscheduled.
      // pendingTasks.track holds each iteration body's promise so the
      // workflow-end drain catches orphaned continuations.
      for (const bodyNodeId of firstBodyNodes) {
        await pendingTasks.track(
          executeBodyNode(
            bodyNodeId,
            bodyVisited,
            scopedOutputs,
            bodyResults,
            bodyEdgesBySource,
            collectNodeId,
            iterationMeta,
            bodyEdgesBySourceHandle
          )
        );
      }

      // If any body node failed, surface the error in the iteration result.
      // The `__forEachBodyFailure` marker lets the post-loop aggregation tell a
      // genuine body failure apart from a successful iteration whose output
      // happens to be shaped like `{ success: false }`.
      const bodyFailure = Object.entries(bodyResults).find(
        ([, r]) => !r.success
      );
      if (bodyFailure) {
        console.log(
          `[Workflow Executor] For Each "${getNodeName(forEachNode)}" iteration ${index} failed at node "${getNodeName(nodeMap.get(bodyFailure[0]) ?? forEachNode)}" (${bodyFailure[0]}): ${bodyFailure[1].error}`
        );
        return {
          __forEachBodyFailure: true as const,
          success: false as const,
          error: bodyFailure[1].error ?? "Body node failed",
          nodeId: bodyFailure[0],
        };
      }

      // Capture output from the last body node(s) that produced data.
      // Two sources:
      //   1. If a legacy in-body Collect terminates the body, prefer the
      //      nodes that fed into it (closest to the loop's "result").
      //   2. Canonical done-handle wiring: the body chain has no in-body
      //      Collect, so we just pick the last body node that produced
      //      output.
      // The Condition-skipped fallback below covers either mode.
      let iterationOutput: unknown;
      if (captureCollectNodeId) {
        for (const bodyNodeId of bodyNodeIds) {
          const targets = bodyEdgesBySource.get(bodyNodeId) ?? [];
          if (targets.includes(captureCollectNodeId)) {
            const sanitizedBodyId = bodyNodeId.replace(/[^a-zA-Z0-9]/g, "_");
            const output = scopedOutputs[sanitizedBodyId];
            if (output?.data !== undefined) {
              iterationOutput = output.data;
            }
          }
        }
      }

      // Fallback: last body node with output (handles skipped Conditions
      // and the canonical done-handle pattern with no in-body Collect).
      if (iterationOutput === undefined) {
        for (const bodyNodeId of bodyNodeIds) {
          const sanitizedBodyId = bodyNodeId.replace(/[^a-zA-Z0-9]/g, "_");
          const output = scopedOutputs[sanitizedBodyId];
          if (output?.data !== undefined) {
            iterationOutput = output.data;
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
      "@/lib/workflow/nodes/for-each/concurrency"
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

    // 5a. If any iteration failed, flip the For Each node's own log row to error
    // so the UI can surface which step errored rather than showing all green.
    const firstIterationFailure = iterationResults.find(
      (r): r is { success: false; error: string } =>
        r !== null &&
        typeof r === "object" &&
        "success" in (r as object) &&
        (r as { success: unknown }).success === false
    );
    if (firstIterationFailure && executionId) {
      await triggerStep({
        triggerData: {},
        _recordForEachError: {
          executionId,
          nodeId: forEachNodeId,
          error: firstIterationFailure.error,
        },
      });
    }

    // 5b. Mark body nodes as visited in the parent scope
    for (const bodyNodeId of bodyNodeIds) {
      currentVisited.add(bodyNodeId);
    }

    // 6. Route the iteration aggregate to the post-loop continuation.
    // Routing priority is encoded in `planIterationContinuation`:
    //   aggregate-collect: fire the Collect step with `{ results, count }`,
    //                      write its output, mark it visited, and dispatch
    //                      its downstream via continueAfterCollect.
    //   done-targets:      no Collect on done; dispatch the targets as
    //                      ordinary post-loop steps via continueWithDoneTargets
    //                      (no aggregation injection).
    //   none:              fire-and-forget loop, nothing to do here.
    if (continuation.kind === "aggregate-collect") {
      const aggregateCollectNodeId = continuation.collectNodeId;
      const collectData = {
        results: iterationResults,
        count: iterationResults.length,
      };
      const sanitizedCollectId = aggregateCollectNodeId.replace(
        /[^a-zA-Z0-9]/g,
        "_"
      );
      const collectNode = nodeMap.get(aggregateCollectNodeId);
      const collectLabel = collectNode ? getNodeName(collectNode) : "Collect";

      const collectAction = SYSTEM_ACTIONS.Collect;
      if (collectAction) {
        const mod = await collectAction.importer();
        await mod[collectAction.stepFunction]({
          ...collectData,
          _context: {
            executionId,
            nodeId: aggregateCollectNodeId,
            nodeName: collectLabel,
            nodeType: "Collect",
            forEachNodeId,
            organizationId,
            orgSlug: organizationSlug,
            createdBy,
            workflowId,
          } satisfies StepContext,
        });
      }

      currentOutputs[sanitizedCollectId] = {
        label: collectLabel,
        data: collectData,
      };
      currentResults[aggregateCollectNodeId] = {
        success: true,
        data: collectData,
      };
      currentVisited.add(aggregateCollectNodeId);

      // Skip the legacy in-body Collect in mixed wiring: don't re-fire it,
      // but mark it visited so the parent DAG dispatcher leaves it alone.
      if (
        doneCollectNodeId &&
        collectNodeId &&
        collectNodeId !== doneCollectNodeId
      ) {
        currentVisited.add(collectNodeId);
      }

      if (continueAfterCollect) {
        await continueAfterCollect(aggregateCollectNodeId);
      }
    } else if (
      continuation.kind === "done-targets" &&
      continueWithDoneTargets
    ) {
      await continueWithDoneTargets(forEachNodeId, continuation.targets);
    }

    return {
      arrayLength: resolvedArray.length,
      maxIterations,
      iterationsRan: itemsToProcess.length,
      failedIterations: firstIterationFailure === undefined ? 0 : 1,
      firstFailureError: firstIterationFailure?.error,
      firstFailureNodeId: undefined,
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
      const settled = await pendingTasks.track(
        Promise.allSettled(readyIds.map((id) => executeNode(id, visited)))
      );
      processSettledResults(settled, readyIds);
    }
  }

  /**
   * Continue execution downstream of a condition node, honoring the taken
   * handle and propagating skips on the not-taken handle. Shared by the normal
   * post-step path and the spurious-completion recovery path so a recovered
   * condition routes exactly like one that completed normally. Routing a
   * condition through `edgesBySource` instead fires the not-taken edge (e.g. a
   * `false`-handle OR-join) on a branch that should have been skipped.
   */
  async function continueFromCondition(
    nodeId: string,
    conditionResult: boolean | undefined,
    visited: Set<string>
  ): Promise<void> {
    const handleMap = edgesBySourceHandle.get(nodeId);
    if (!handleMap) {
      // Legacy fallback: no sourceHandle on edges, use old gate behavior
      if (conditionResult === true) {
        const nextNodes = edgesBySource.get(nodeId) ?? [];
        await executeReadyDownstream(nodeId, nextNodes, visited);
      }
      return;
    }

    // Handle-aware routing: use the taken handle to determine targets
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
      takenTargets: handleTargets,
    });
    await executeReadyDownstream(nodeId, handleTargets, visited);

    // Propagate skip signals for the not-taken branch so convergence nodes
    // downstream receive arrival signals from skipped sources. A convergence
    // node runs only if it also got a real arrival; if every incoming edge was
    // skipped it is added to `skippedNodes` and the skip continues downstream.
    // This both unblocks genuine convergence and stops an all-skipped OR-join
    // from firing.
    const skippedTargets = handleMap.get(notTakenHandle) ?? [];
    if (skippedTargets.length > 0) {
      const unblockedIds = propagateConvergenceSkips(
        nodeId,
        skippedTargets,
        edgesBySource,
        edgesByTarget,
        convergenceArrivals,
        convergenceSkipArrivals,
        skippedNodes,
        visited
      );
      if (unblockedIds.length > 0) {
        const settled = await pendingTasks.track(
          Promise.allSettled(unblockedIds.map((id) => executeNode(id, visited)))
        );
        processSettledResults(settled, unblockedIds);
      }
    }
  }

  // Helper to execute a single node
  async function executeNode(nodeId: string, visited: Set<string> = new Set()) {
    console.log("[Workflow Executor] Executing node:", nodeId);

    if (visited.has(nodeId)) {
      console.log("[Workflow Executor] Node already visited, skipping");
      return; // Prevent cycles
    }
    visited.add(nodeId);
    attemptedNodes.add(nodeId);

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
          // On-chain event triggers (Event, Tempo Transfer) arrive with each arg
          // as a { value, type } wrapper; deserializeTriggerInput turns them into
          // real scalars so conditions and templates compare against the value,
          // not the wrapper object. Other trigger types pass through untouched.
          triggerData = {
            ...triggerData,
            ...deserializeTriggerInput(triggerType, triggerInput),
          };

          if (triggerType === "Event" || triggerType === "Transfer") {
            // Enrich event data with explorer links so the execution log UI can
            // render clickable transaction/address links. Uses a step function
            // to keep db/schema out of the workflow bundle.
            if (config.network) {
              try {
                const { enrichExplorerLinks } = await import(
                  "@/lib/workflow/nodes/enrich-explorer-links/step"
                );
                await enrichExplorerLinks(
                  triggerData,
                  config.network as string | number
                );
              } catch {
                // Non-critical: skip explorer links if lookup fails
              }
            }
          } else if (
            triggerType === "Schedule" &&
            "triggerTime" in triggerInput &&
            triggerInput.triggerTime
          ) {
            // Normalize schedule trigger: map triggerTime -> triggeredAt so the
            // runtime field matches the declared output schema.
            triggerData.triggeredAt = triggerInput.triggerTime;
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
          createdBy,
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

        // KEEP-395 (Bug 1): for convergence-target nodes (multiple incoming
        // edges) the closure-captured `outputs` map can carry a stale snapshot
        // for the LAST predecessor when the SDK replays/rehydrates this
        // workflow across a process boundary. `mergeFromAuthority` consults the
        // in-process tracker first (fast path, zero I/O) and falls back to
        // `workflow_execution_logs` for any predecessor missing from the
        // tracker -- which happens when predecessors ran on a different pod.
        // Emits a `tracker_degraded` log when the DB fallback fires so prod
        // logs surface cross-pod resumes without alerting (observability only).
        const predecessorIds = edgesByTarget.get(nodeId) ?? [];
        const liveOutputs =
          predecessorIds.length > 1
            ? await mergeFromAuthority({
                outputs,
                executionId,
                predecessorIds,
                nodeMap,
                getNodeName,
              })
            : outputs;

        if (
          predecessorIds.length > 1 &&
          liveOutputs !== outputs &&
          !warnedDegradationConvergenceIds.has(nodeId)
        ) {
          const trackerEmpty =
            getSuccessfulSteps(executionId ?? "") === undefined;
          if (trackerEmpty) {
            warnedDegradationConvergenceIds.add(nodeId);
            logSystemError(
              ErrorCategory.WORKFLOW_ENGINE,
              "[Workflow Executor] tracker_degraded -- DB fallback fired for convergence merge (cross-pod resume)",
              new Error(
                `tracker_degraded execution_id=${executionId ?? ""} convergence_node_id=${nodeId}`
              ),
              {
                ...baseLogLabels,
                node_id: nodeId,
              }
            );
          }
        }

        const processedConfig = processActionConfig(
          config,
          actionType,
          liveOutputs,
          { nodeId: node.id, nodeLabel: getNodeName(node) }
        );

        // Build step context for logging (stepHandler will handle the logging)
        const stepContext: StepContext = {
          executionId,
          nodeId: node.id,
          nodeName: getNodeName(node),
          nodeType: actionType,
          triggerType: workflowTriggerType,
          organizationId,
          orgSlug: organizationSlug,
          createdBy,
          workflowId,
        };

        // Execute the action step with stepHandler (logging is handled inside)
        // IMPORTANT: We pass integrationId via config, not actual credentials
        // Steps fetch credentials internally using fetchCredentials(integrationId)
        console.log("[Workflow Executor] Calling executeActionStep");
        const stepResult = await executeActionStep({
          actionType,
          config: processedConfig,
          outputs: liveOutputs,
          context: stepContext,
          stepFunctions,
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
          const errorResult = stepResult as {
            success: false;
            error?: string;
            errorClass?: ExecutionResult["errorClass"];
          };
          result = {
            success: false,
            error:
              errorResult.error ||
              `Step "${actionType}" in node "${node.data.label || node.id}" failed without a specific error message.`,
            errorClass: errorResult.errorClass,
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
          // KEEP-468: same strict-mode treatment as action steps so an
          // unresolved array reference cannot iterate zero times silently.
          const forEachTracker = createTracker();
          const forEachConfig = processTemplates(
            node.data.config ?? {},
            outputs,
            forEachTracker
          );
          assertResolved(forEachTracker, forEachConfig, {
            nodeId: node.id,
            nodeLabel: getNodeName(node),
            actionType: "For Each",
          });
          const iterationSummary = await handleForEachExecution({
            forEachNodeId: nodeId,
            forEachNode: node,
            processedConfig: forEachConfig,
            currentOutputs: outputs,
            currentResults: results,
            currentVisited: visited,
            continueAfterCollect: async (collectId) => {
              const nextNodes = edgesBySource.get(collectId) ?? [];
              await executeReadyDownstream(collectId, nextNodes, visited);
            },
            continueWithDoneTargets: async (fromNodeId, targets) => {
              await executeReadyDownstream(fromNodeId, targets, visited);
            },
          });

          // Update the For Each node's output with resolved iteration metadata
          const sanitizedFEId = nodeId.replace(/[^a-zA-Z0-9]/g, "_");
          outputs[sanitizedFEId] = {
            label: getNodeName(node),
            data: iterationSummary,
          };
          // KEEP-586: A failed iteration body must fail the For Each node so
          // computeFinalSuccess marks the run as error instead of silently
          // reporting success while the loop dropped work mid-iteration.
          const feFailed =
            typeof iterationSummary === "object" &&
            iterationSummary !== null &&
            "failedIterations" in iterationSummary &&
            (iterationSummary as { failedIterations: number })
              .failedIterations > 0;
          results[nodeId] = feFailed
            ? {
                success: false,
                error:
                  (iterationSummary as { firstFailureError?: string })
                    .firstFailureError ?? "For Each iteration body failed",
                data: iterationSummary,
              }
            : { success: true, data: iterationSummary };
        } else if (currentActionType === "Condition") {
          // For condition nodes, route to true/false handle targets
          const conditionResult = (result.data as { condition?: boolean })
            ?.condition;
          await continueFromCondition(nodeId, conditionResult, visited);
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
      const errorMessage = await getErrorMessageAsync(error);

      // KEEP-398: Reconcile spurious max-retries / step-completion errors using
      // the step-success authority (in-process tracker fast-path with DB
      // fallback). The Workflow DevKit framework's post-step "step_completed"
      // event is occasionally lost under heavy fan-in (e.g. many parallel
      // reads converging into a code/run-code combine). When that happens,
      // useStep re-fires the step on resume and -- with
      // runCodeStep.maxRetries=0 -- the framework throws
      // "Step ... exceeded max retries" / "Step ... failed after N retries"
      // even though the step body returned successfully and recorded its
      // output via recordStepSuccess.
      //
      // KEEP-431: Use getCompletedStepOutput (tracker + DB) instead of
      // getSuccessfulSteps (tracker only) so cross-pod recovery works in
      // catch as well as post-drain. The tracker is process-local; on the
      // x402 / call_workflow path the SDK frequently resumes on a fresh pod
      // whose tracker is empty, leaving the in-catch branch unable to
      // recover and forcing reliance on post-drain. Reading the DB-backed
      // authority here makes the recovery uniform across both paths.
      const isSpuriousMaxRetries =
        EXCEEDED_MAX_RETRIES_REGEX.test(errorMessage) ||
        FAILED_AFTER_RETRIES_REGEX.test(errorMessage) ||
        NO_STEP_COMPLETION_REGEX.test(errorMessage);
      let recordedOutput =
        isSpuriousMaxRetries && executionId
          ? (await getCompletedStepOutput(executionId, nodeId))?.output
          : undefined;
      // The framework re-fires a step after a lost completion event and throws
      // "exceeded max retries" BEFORE the step body's success row is committed,
      // so the one-shot read above misses by ~0.3-0.5s. Wait for the
      // late-landing success inside a step boundary (DB-backed, replay-safe via
      // memoization) before giving up, so the reconcile path below recovers it
      // instead of nullifying the node and unblocking convergence with no data.
      // The poll itself is a step and can throw its own max-retries error. An
      // escape here would abort the rest of this catch, and the convergence
      // signal at the bottom is what keeps a fan-in join from waiting forever
      // on an arrival that never comes -- so swallow the failure and fall
      // through to the normal failure path instead.
      if (isSpuriousMaxRetries && executionId && recordedOutput === undefined) {
        try {
          recordedOutput = (
            await awaitCompletedStepOutputStep(
              executionId,
              nodeId,
              SPURIOUS_RECOVERY_POLL_TIMEOUT_MS,
              SPURIOUS_RECOVERY_POLL_INTERVAL_MS
            )
          )?.outputRaw;
        } catch (pollError) {
          logSystemWarn(
            ErrorCategory.WORKFLOW_ENGINE,
            "[Workflow Executor] Spurious-recovery poll failed; falling back to failure path",
            pollError instanceof Error
              ? pollError
              : new Error(String(pollError)),
            { ...baseLogLabels, node_id: nodeId }
          );
        }
      }
      if (isSpuriousMaxRetries && recordedOutput !== undefined) {
        // Recovered execution: the step body succeeded, only the SDK's
        // bookkeeping tripped. Emit a structured warn (no Sentry) and a
        // dedicated counter so we can alert on rate without one Sentry
        // event per recovered run.
        getMetricsCollector().incrementCounter(
          "workflow.executor.spurious_recovery.total",
          {
            source: "in_catch",
            ...(workflowId ? { [LabelKeys.WORKFLOW_ID]: workflowId } : {}),
            ...(organizationId ? { [LabelKeys.ORG_ID]: organizationId } : {}),
            ...(organizationPlan ? { [LabelKeys.PLAN]: organizationPlan } : {}),
          }
        );
        const reconciledResult: ExecutionResult = {
          success: true,
          data: recordedOutput,
        };
        results[nodeId] = reconciledResult;
        const reconciledSanitizedNodeId = nodeId.replace(/[^a-zA-Z0-9]/g, "_");
        outputs[reconciledSanitizedNodeId] = {
          label: getNodeName(node),
          data: recordedOutput,
        };
        // A recovered condition must route by handle, exactly like the normal
        // path. Continuing through the handle-agnostic `edgesBySource` here
        // fires the not-taken edge (e.g. a `false`-handle OR-join) on a branch
        // that should have been skipped, which is what caused the join to run
        // even though every condition evaluated true.
        const recoveredActionType =
          node.data.type === "action"
            ? (node.data.config?.actionType as string | undefined)
            : undefined;
        if (recoveredActionType === "Condition") {
          const recoveredCondition = (
            recordedOutput as { condition?: boolean } | undefined
          )?.condition;
          await continueFromCondition(nodeId, recoveredCondition, visited);
        } else {
          const nextNodes = edgesBySource.get(nodeId) ?? [];
          await executeReadyDownstream(nodeId, nextNodes, visited);
        }
        return;
      }

      logSystemError(
        ErrorCategory.WORKFLOW_ENGINE,
        "[Workflow Executor] Error executing node:",
        error,
        {
          ...baseLogLabels,
          node_id: nodeId,
        }
      );
      const errorResult = {
        success: false,
        error: errorMessage,
      };
      results[nodeId] = errorResult;

      // KEEP-468: TemplateResolutionError aborts before executeActionStep runs,
      // so withStepLogging never writes a workflow_execution_logs row for the
      // failing node. Without that row, listTrulyFailedNodes inside
      // logWorkflowCompleteDb concludes "no node failed" and CAS-flips the
      // workflow status from 'error' to 'success' as a spurious-SDK reconcile.
      // Route through triggerStep's step boundary (DB access is forbidden in
      // the workflow body) to persist a failure log so the run panel surfaces
      // it AND the reconciler keeps status='error'. Wrapped in try/catch:
      // a logging failure must never block the workflow from aborting.
      if (error instanceof TemplateResolutionError && executionId) {
        try {
          await triggerStep({
            triggerData: {},
            _recordStepFailure: {
              executionId,
              nodeId,
              nodeName: getNodeName(node),
              nodeType: node.data.type,
              error: errorMessage,
            },
          });
        } catch (logError) {
          logSystemError(
            ErrorCategory.WORKFLOW_ENGINE,
            "[Workflow Executor] Failed to record TemplateResolutionError step log",
            logError,
            { ...baseLogLabels, node_id: nodeId }
          );
        }
      }

      // Catch-time output write. Preserves a prior in-memory success when one
      // exists (the SDK occasionally replays a step after its first attempt
      // has already populated `outputs[sanitizedNodeId]` under heavy fan-in),
      // and otherwise falls back to `{ data: null }` so downstream templates
      // resolve to a sentinel instead of `undefined`. The previous
      // unconditional overwrite discarded replay-survivor output and caused
      // downstream resolvers to throw `Node "X" produced no data.`
      const sanitizedNodeId = nodeId.replace(/[^a-zA-Z0-9]/g, "_");
      recordCatchOutput(outputs, sanitizedNodeId, getNodeName(node));

      // Signal arrival at downstream convergence nodes to prevent deadlocks.
      // If this failure was the last arrival, execute the convergence node
      // with partial data rather than hanging forever.
      //
      // A genuinely-failed condition is the exception: it has no taken handle,
      // and signaling a real arrival through the handle-agnostic `edgesBySource`
      // would fire a not-taken OR-join (e.g. an alert on the `false` handle) on
      // a branch that never produced a decision. Skip the signal for condition
      // nodes; the run is already marked failed and the join is left unrun
      // rather than mis-fired. Non-condition merges still signal so a
      // partial-data join does not hang.
      const failedActionType =
        node.data.type === "action"
          ? (node.data.config?.actionType as string | undefined)
          : undefined;
      if (failedActionType !== "Condition") {
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
    const triggerSettled = await pendingTasks.track(
      Promise.allSettled(triggerNodeIds.map((id) => executeNode(id)))
    );
    processSettledResults(triggerSettled, triggerNodeIds);

    // KEEP-395 (Bug 2): drain any in-flight downstream branches before
    // finalisation. The recursive executeReadyDownstream chain runs in the
    // workflow layer and can be truncated by SDK checkpoint resume, leaving
    // an orphaned promise in pendingTasks. Drain catches those so the
    // workflow does not finalise before all scheduled nodes complete.
    //
    // Drain is bounded by a timeout (default 5min, override via
    // KH_EXECUTOR_DRAIN_TIMEOUT_MS) to prevent a hung step (most plugin
    // steps lack AbortSignal) from stalling the workflow indefinitely.
    if (process.env.DEBUG_DRAIN === "1") {
      console.log(
        `[Workflow Executor] drain starting with ${pendingTasks.size()} pending`
      );
    }
    // Snapshot result keys BEFORE drain so we can identify drained-node
    // failures and re-evaluate finalSuccess after drain (KEEP-395 Bug 2
    // hardening: orphan failures must flow into finalSuccess, not be silently
    // accepted as success).
    const resultKeysBeforeDrain = new Set(Object.keys(results));
    await pendingTasks.drain({
      onTimeout: (pendingCount) => {
        logSystemError(
          ErrorCategory.WORKFLOW_ENGINE,
          "[Workflow Executor] drain timed out with pending promises -- workflow may finalise with incomplete state",
          new Error(
            `drain_timeout pending=${pendingCount} workflow_id=${workflowId ?? "unknown"} execution_id=${executionId ?? "unknown"}`
          ),
          {
            ...baseLogLabels,
            pending_count: String(pendingCount),
          }
        );
      },
    });

    // KEEP-398: Post-drain reconciliation pass. After drain completes all
    // pending promises have settled, so any tracker writes that raced the SDK's
    // max-retries throw have now landed. For any result entry that still shows a
    // spurious error, consult the step-success-tracker and then
    // workflow_execution_logs. If a success record exists, override the failed
    // entry. This catches both the 20% in-process case (tracker populated after
    // drain) and the 80% cross-pod case (tracker empty, DB authoritative).
    await reconcileSpuriousFailures({
      executionId,
      results,
      workflowId,
      organizationId,
      organizationPlan,
    });

    // A node the executor never scheduled is absent from `results`, so on its
    // own it cannot fail the run. Record one failure per orphan before the
    // final tally so a fan-in join that never fired -- and the alerting steps
    // behind it -- surface as an error instead of a green run.
    const orphanedNodes = findOrphanedNodes({
      attempted: attemptedNodes,
      results,
      skipped: skippedNodes,
      edgesByTarget,
      conditionNodeIds,
      excludedNodeIds: loopBodyNodeIds,
    });
    for (const orphanId of orphanedNodes) {
      const orphanNode = nodeMap.get(orphanId);
      const upstreamCount = edgesByTarget.get(orphanId)?.length ?? 0;
      results[orphanId] = {
        success: false,
        error: `Node "${orphanNode ? getNodeName(orphanNode) : orphanId}" never executed although all ${upstreamCount} upstream branches completed`,
      };
    }
    if (orphanedNodes.length > 0) {
      logSystemError(
        ErrorCategory.WORKFLOW_ENGINE,
        "[Workflow Executor] Nodes never scheduled despite a clean upstream",
        new Error(`orphaned_nodes=${orphanedNodes.join(",")}`),
        {
          ...baseLogLabels,
          orphaned_node_count: String(orphanedNodes.length),
        }
      );
    }

    // Branch-aware finalSuccess: exclude nodes on dead (not-taken) condition branches.
    // KEEP-395 Bug 2 hardening: re-evaluated AFTER drain so any failures from
    // drained orphan nodes are reflected here. The pre-drain computation (now
    // unused) only ever saw nodes whose call-stack reached processSettledResults;
    // drained orphans land in `results` while drain awaits them.
    // `skippedNodes` is the authoritative set of genuinely-skipped nodes built
    // during execution: a node only lands here when every incoming path was
    // not taken. A node that actually executed (even one wired to a condition's
    // not-taken handle but reached via a real arrival) is absent, so its
    // failure is never masked as skipped.
    const finalSuccess = computeFinalSuccess(results, skippedNodes);

    // Surface drained-orphan failures explicitly so prod logs make the
    // SDK-checkpoint-truncation case visible (otherwise the failure looks
    // identical to a normal sync-path failure).
    const drainedNodeIds = Object.keys(results).filter(
      (id) => !resultKeysBeforeDrain.has(id)
    );
    const drainedFailures = drainedNodeIds.filter(
      (id) => !(results[id]?.success || skippedNodes.has(id))
    );
    if (drainedFailures.length > 0) {
      console.log(
        "[Workflow Executor] drained orphan node failures captured:",
        drainedFailures
      );
    }
    const duration = Date.now() - workflowStartTime;

    // Diagnostic logging for branching workflow failures
    if (!finalSuccess && conditionDecisions.size > 0) {
      const failedNodes = Object.entries(results)
        .filter(([, r]) => !r.success)
        .map(([id, r]) => ({ id, error: r.error }));
      const unexecutedNodes = [...nodeMap.keys()].filter(
        (id) => !(id in results)
      );
      console.log(
        "[Workflow Executor] Branch-aware finalSuccess=false diagnostic:",
        {
          failedNodes,
          conditionDecisions: [...conditionDecisions.entries()].map(
            ([id, d]) => ({ id, ...d })
          ),
          skippedTargets: [...skippedNodes],
          unexecutedNodes,
        }
      );
    }

    const firstFailure = Object.values(results).find((r) => !r.success);

    recordWorkflowComplete({
      workflowId,
      executionId,
      triggerType,
      durationMs: duration,
      success: finalSuccess,
      error: firstFailure?.error,
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
            error: finalSuccess ? undefined : firstFailure?.error,
            // Authoritative type declared by the failing step (if any) wins
            // over the message-string classifier at finalization.
            errorClass: finalSuccess ? undefined : firstFailure?.errorClass,
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
      clearOutputCache(executionId);
    }
  }
}
