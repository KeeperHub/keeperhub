import type { WorkflowExecutionInput } from "@/lib/workflow/executor/executor.workflow";
import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow/store";

/** Minimal workflow shape needed to build executor input. */
export type ExecutorInputWorkflow = {
  id: string;
  userId: string;
  organizationId: string | null;
  nodes: unknown;
  edges: unknown;
};

/**
 * Build the executor input from a workflow row.
 *
 * Centralised so every dispatch entry point (scheduled K8s job, in-process,
 * MCP) threads the same context. `organizationId` is the credential
 * authority: the org owns the workflow, and steps authorize credential use
 * as the ORG principal (this organizationId). `createdBy` is
 * the workflow creator for audit attribution only - it confers no
 * credential access.
 *
 * Never refuse here based on triggerInput. It is caller-writable on the MCP
 * call and webhook paths, and every runner calls this after the executor has
 * claimed the row, so a refusal would strand or fail a run instead of
 * skipping it. Pyth signal expiry is enforced by the executor before claim.
 */
export function buildExecutorInput(
  workflow: ExecutorInputWorkflow,
  params: {
    triggerInput?: Record<string, unknown>;
    executionId?: string;
    organizationName?: string;
    organizationSlug?: string;
    organizationPlan?: string;
  }
): WorkflowExecutionInput {
  return {
    nodes: workflow.nodes as WorkflowNode[],
    edges: workflow.edges as WorkflowEdge[],
    triggerInput: params.triggerInput,
    executionId: params.executionId,
    workflowId: workflow.id,
    organizationId: workflow.organizationId ?? undefined,
    createdBy: workflow.userId,
    organizationName: params.organizationName,
    organizationSlug: params.organizationSlug,
    organizationPlan: params.organizationPlan,
  };
}
