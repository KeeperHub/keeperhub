/**
 * Pure, testable runner for For Each iteration bodies.
 *
 * Extracted from `executeBodyNode` inside `executor.workflow.ts` so the
 * recursion can be exercised directly in unit tests with a mock step runner,
 * instead of having to spin up the full Vercel Workflow runtime.
 *
 * The contract this enforces matches what the production executor must do
 * inside a single For Each iteration:
 *
 * 1. Skip the node if it is already visited or is the loop's Collect boundary.
 * 2. Run the node's step via the injected `runStep` callback. Persist the
 *    result on `bodyResults` and the step output on `scopedOutputs` (sanitized
 *    nodeId is used as the key, matching the executor's template-resolution
 *    expectations).
 * 3. If the step failed (`result.success === false`), stop the branch.
 * 4. If the actionType is `Condition`, dispatch ONLY to the targets returned
 *    by `resolveBodyConditionTargets` (handle-aware routing).
 * 5. If the actionType is `For Each`, hand off to the caller-provided
 *    `handleNestedForEach`. The nested handler is responsible for running
 *    iterations and continuing past its Collect boundary.
 * 6. For every other (non-Condition, non-For-Each) action with a successful
 *    result, recurse into every target in `bodyEdgesBySource[nodeId]`. THIS
 *    is the contract a regression test confirmed: a successful action with
 *    a downstream edge must dispatch to that edge, regardless of how many
 *    actions or conditions came before it in the iteration body.
 */
import type { EdgesBySourceHandle } from "@/lib/workflow/editor/edge-handle-utils";
import {
  type ForEachIterationSummary,
  resolveBodyConditionTargets,
} from "@/lib/workflow/executor/executor.workflow";
import {
  EXCEEDED_MAX_RETRIES_REGEX,
  FAILED_AFTER_RETRIES_REGEX,
  NO_STEP_COMPLETION_REGEX,
} from "@/lib/workflow/executor/runner-error-patterns";
import type { StepContext } from "@/lib/workflow/executor/step-handler";
import type { WorkflowNode } from "@/lib/workflow/store";

/** Result captured for each step run inside a body iteration. */
export type BodyExecutionResult = {
  success: boolean;
  data?: unknown;
  error?: string;
};

export type BodyNodeOutputs = Record<string, { label: string; data: unknown }>;

/** Metadata about the active iteration; threaded into the step context. */
export type IterationMeta = {
  iterationIndex: number;
  forEachNodeId: string;
};

/** Step runner callback. The runner is responsible for invoking the actual
 *  step (e.g. via the workflow SDK in production, or a vi.fn() in tests). */
export type BodyStepRunner = (params: {
  node: WorkflowNode;
  actionType: string;
  processedConfig: Record<string, unknown>;
  scopedOutputs: BodyNodeOutputs;
  iterationMeta: IterationMeta | undefined;
  stepContext: StepContext;
}) => Promise<unknown>;

/** Hook invoked when the body encounters a nested For Each node. The caller
 *  must run the nested iterations and any post-Collect continuation. */
export type NestedForEachHandler = (params: {
  forEachNodeId: string;
  forEachNode: WorkflowNode;
  processedConfig: Record<string, unknown>;
  scopedOutputs: BodyNodeOutputs;
  bodyResults: Record<string, BodyExecutionResult>;
  bodyVisited: Set<string>;
}) => Promise<ForEachIterationSummary>;

/** KEEP-543: Resolver for spurious-max-retries inside iteration bodies. When
 *  the Workflow DevKit throws "exceeded max retries" because it lost the
 *  step_completed event under heavy fan-in, the body step's output may still
 *  be persisted in the step-success-tracker / workflow_execution_logs. The
 *  resolver consults that authority and returns the recovered output. Returns
 *  null when no authority record exists -- the failure is real, not spurious. */
export type SpuriousRecoveryResolver = (params: {
  nodeId: string;
  iterationMeta: IterationMeta;
}) => Promise<{ output: unknown } | null>;

export type RunBodyContext = {
  nodeMap: ReadonlyMap<string, WorkflowNode>;
  bodyEdgesBySource: Map<string, string[]>;
  bodyEdgesBySourceHandle: EdgesBySourceHandle | undefined;
  collectNodeId: string | undefined;
  bodyVisited: Set<string>;
  bodyResults: Record<string, BodyExecutionResult>;
  scopedOutputs: BodyNodeOutputs;
  iterationMeta: IterationMeta | undefined;
  runStep: BodyStepRunner;
  /** Optional hook for nested For Each handling. Called instead of the generic
   *  downstream walk when the visited node is itself a For Each. */
  handleNestedForEach?: NestedForEachHandler;
  /** Optional resolver consulted when a body step throws. When the step body
   *  already recorded a success row, the resolver returns the recovered output
   *  so the iteration treats the step as a success and continues recursing
   *  downstream. Covers both an SDK-lost step_completed event and a long step
   *  abandoned by the runtime after its body completed. Omitted in unit tests
   *  that don't exercise the recovery path. */
  resolveSpuriousRecovery?: SpuriousRecoveryResolver;
  /** Optional hook fired when a thrown step is recovered from the success
   *  authority. Used by the executor to emit observability metrics. `reason`
   *  distinguishes the lost-completion-event case from a long step abandoned
   *  after completing. */
  onSpuriousRecovery?: (params: {
    nodeId: string;
    iterationMeta: IterationMeta;
    reason: "spurious_max_retries" | "abandoned_completion";
  }) => void;
  /** Process action config (template substitution, dbQuery rewriting, etc.). */
  processConfig: (
    config: Record<string, unknown>,
    actionType: string,
    outputs: BodyNodeOutputs,
    assertContext?: { nodeId?: string; nodeLabel?: string }
  ) => Record<string, unknown>;
  /** Resolve a friendly node label for logging / output keys. */
  getNodeName: (node: WorkflowNode) => string;
  /** Async error stringifier (matches executor.workflow.ts getErrorMessageAsync). */
  getErrorMessageAsync: (error: unknown) => Promise<string>;
  /** Inject the workflow's builtin variables into scopedOutputs before each
   *  step runs. The executor uses this to expose `__system.data.unixTimestamp`
   *  and similar variables to template resolution. */
  injectBuiltinVariables: (scopedOutputs: BodyNodeOutputs) => void;
  /** Common StepContext fields (executionId, organizationId, etc.) that don't
   *  vary per node. Per-node fields (nodeId, nodeName, nodeType) are added
   *  inside this function. */
  baseStepContext: Omit<StepContext, "nodeId" | "nodeName" | "nodeType">;
};

const SANITIZE_PATTERN = /[^a-zA-Z0-9]/g;

function sanitizeNodeId(nodeId: string): string {
  return nodeId.replace(SANITIZE_PATTERN, "_");
}

function isErrorStepResult(stepResult: unknown): boolean {
  return (
    typeof stepResult === "object" &&
    stepResult !== null &&
    "success" in stepResult &&
    (stepResult as { success: boolean }).success === false
  );
}

function isDisabled(node: WorkflowNode): boolean {
  return node.data.enabled === false;
}

async function recurseInto(
  targets: readonly string[],
  ctx: RunBodyContext
): Promise<void> {
  for (const next of targets) {
    await runBodyNode(next, ctx);
  }
}

function isSpuriousMaxRetriesError(message: string): boolean {
  return (
    EXCEEDED_MAX_RETRIES_REGEX.test(message) ||
    FAILED_AFTER_RETRIES_REGEX.test(message) ||
    NO_STEP_COMPLETION_REGEX.test(message)
  );
}

/**
 * Continue the iteration downstream after a node has been successfully recorded
 * (either normally or via spurious-recovery). Mirrors the routing decisions
 * inside `runBodyNode`'s success path: For Each delegates to the nested handler
 * AND falls through to its downstream, Condition consults handle-aware
 * targets, plain actions recurse into every downstream edge.
 */
async function routeAfterSuccess(params: {
  nodeId: string;
  node: WorkflowNode;
  actionType: string;
  processedConfig: Record<string, unknown>;
  result: BodyExecutionResult;
  ctx: RunBodyContext;
}): Promise<void> {
  const { nodeId, node, actionType, processedConfig, result, ctx } = params;

  if (actionType === "For Each") {
    if (ctx.handleNestedForEach) {
      const summary = await ctx.handleNestedForEach({
        forEachNodeId: nodeId,
        forEachNode: node,
        processedConfig,
        scopedOutputs: ctx.scopedOutputs,
        bodyResults: ctx.bodyResults,
        bodyVisited: ctx.bodyVisited,
      });
      if (summary.failedIterations > 0) {
        ctx.bodyResults[nodeId] = {
          success: false,
          error: summary.firstFailureError ?? "For Each iteration body failed",
          data: summary,
        };
        return;
      }
    }
    const downstream = ctx.bodyEdgesBySource.get(nodeId) ?? [];
    await recurseInto(downstream, ctx);
    return;
  }

  if (actionType === "Condition") {
    const conditionValue = (result.data as { condition?: boolean })?.condition;
    const conditionTargets = resolveBodyConditionTargets(
      conditionValue === true,
      nodeId,
      ctx.bodyEdgesBySourceHandle,
      ctx.bodyEdgesBySource
    );
    await recurseInto(conditionTargets, ctx);
    return;
  }

  const downstream = ctx.bodyEdgesBySource.get(nodeId) ?? [];
  await recurseInto(downstream, ctx);
}

/**
 * KEEP-543 / KEEP-586: Attempt authority-backed recovery for a body node that
 * just threw. The step-success-tracker (and its workflow_execution_logs
 * fallback) is the source of truth: when the step body recorded a success row,
 * the step succeeded even though the runtime wrapper later threw. Two shapes
 * produce that situation, and both must continue the iteration:
 *
 *   1. The Workflow DevKit lost the step_completed event and re-fired the step
 *      ("exceeded max retries" / "failed after retries" / "did not record
 *      completion").
 *   2. A long-running step -- e.g. a multi-minute web3 event scan -- outran the
 *      runtime's step lease and was abandoned with a generic timeout error
 *      AFTER its body had already completed and persisted its output. Without
 *      recovery the iteration silently drops every node downstream of the slow
 *      step while the run still reports success.
 *
 * We therefore consult the authority on ANY throw rather than gating on the
 * max-retries error shapes. A genuinely failed step has no success row, so the
 * resolver returns null and the caller falls through to the standard failure
 * path -- this never masks a real failure.
 *
 * Returns true when the failure was recovered (caller should NOT record it as a
 * failure); false when the failure is real and the caller should fall through
 * to the standard failure path.
 */
async function attemptSpuriousRecovery(params: {
  nodeId: string;
  node: WorkflowNode;
  actionType: string | undefined;
  processedConfig: Record<string, unknown> | undefined;
  errorMessage: string;
  ctx: RunBodyContext;
}): Promise<boolean> {
  const { nodeId, node, actionType, processedConfig, errorMessage, ctx } =
    params;

  if (!ctx.iterationMeta) {
    return false;
  }
  if (!ctx.resolveSpuriousRecovery) {
    return false;
  }
  if (!actionType) {
    return false;
  }

  const recovered = await ctx.resolveSpuriousRecovery({
    nodeId,
    iterationMeta: ctx.iterationMeta,
  });
  if (recovered === null) {
    return false;
  }

  console.log(
    `[For Each body] recovered "${ctx.getNodeName(node)}" (${nodeId}) from the success authority after it threw; continuing downstream.`
  );

  const result: BodyExecutionResult = {
    success: true,
    data: recovered.output,
  };
  ctx.bodyResults[nodeId] = result;
  const sanitizedId = sanitizeNodeId(nodeId);
  ctx.scopedOutputs[sanitizedId] = {
    label: ctx.getNodeName(node),
    data: recovered.output,
  };

  ctx.onSpuriousRecovery?.({
    nodeId,
    iterationMeta: ctx.iterationMeta,
    reason: isSpuriousMaxRetriesError(errorMessage)
      ? "spurious_max_retries"
      : "abandoned_completion",
  });

  await routeAfterSuccess({
    nodeId,
    node,
    actionType,
    processedConfig: processedConfig ?? {},
    result,
    ctx,
  });

  return true;
}

/**
 * Recursively execute a single body node and its downstream targets within a
 * For Each iteration. See module-level docstring for the contract.
 */
export async function runBodyNode(
  nodeId: string,
  ctx: RunBodyContext
): Promise<void> {
  if (ctx.bodyVisited.has(nodeId)) {
    return;
  }
  if (nodeId === ctx.collectNodeId) {
    return;
  }
  ctx.bodyVisited.add(nodeId);

  const node = ctx.nodeMap.get(nodeId);
  if (!node) {
    return;
  }

  if (isDisabled(node)) {
    const sanitizedId = sanitizeNodeId(nodeId);
    ctx.scopedOutputs[sanitizedId] = {
      label: ctx.getNodeName(node),
      data: null,
    };
    const downstream = ctx.bodyEdgesBySource.get(nodeId) ?? [];
    await recurseInto(downstream, ctx);
    return;
  }

  ctx.injectBuiltinVariables(ctx.scopedOutputs);

  const config = node.data.config ?? {};
  const actionType = config.actionType as string | undefined;
  let processedConfig: Record<string, unknown> | undefined;

  try {
    if (!actionType) {
      ctx.bodyResults[nodeId] = {
        success: false,
        error: `Action node "${node.data.label || node.id}" has no action type configured`,
      };
      return;
    }

    processedConfig = ctx.processConfig(config, actionType, ctx.scopedOutputs, {
      nodeId: node.id,
      nodeLabel: ctx.getNodeName(node),
    });

    const stepContext: StepContext = {
      ...ctx.baseStepContext,
      nodeId: node.id,
      nodeName: ctx.getNodeName(node),
      nodeType: actionType,
      iterationIndex: ctx.iterationMeta?.iterationIndex,
      forEachNodeId: ctx.iterationMeta?.forEachNodeId,
    };

    const stepResult = await ctx.runStep({
      node,
      actionType,
      processedConfig,
      scopedOutputs: ctx.scopedOutputs,
      iterationMeta: ctx.iterationMeta,
      stepContext,
    });

    const result: BodyExecutionResult = isErrorStepResult(stepResult)
      ? {
          success: false,
          error:
            (stepResult as { error?: string }).error ||
            `Step "${actionType}" failed.`,
        }
      : { success: true, data: stepResult };

    ctx.bodyResults[nodeId] = result;
    const sanitizedId = sanitizeNodeId(nodeId);
    ctx.scopedOutputs[sanitizedId] = {
      label: ctx.getNodeName(node),
      data: result.data,
    };

    if (!result.success) {
      return;
    }

    await routeAfterSuccess({
      nodeId,
      node,
      actionType,
      processedConfig,
      result,
      ctx,
    });
  } catch (error) {
    const errorMessage = await ctx.getErrorMessageAsync(error);
    const iter = ctx.iterationMeta?.iterationIndex ?? "-";
    console.log(
      `[For Each body] node "${ctx.getNodeName(node)}" (${nodeId}) threw at iteration ${iter}: ${errorMessage}`
    );

    const recovered = await attemptSpuriousRecovery({
      nodeId,
      node,
      actionType,
      processedConfig,
      errorMessage,
      ctx,
    });
    if (recovered) {
      return;
    }

    console.log(
      `[For Each body] node "${ctx.getNodeName(node)}" (${nodeId}) NOT recovered (no success row in authority); stopping branch -- downstream nodes will not run.`
    );
    ctx.bodyResults[nodeId] = { success: false, error: errorMessage };
  }
}
