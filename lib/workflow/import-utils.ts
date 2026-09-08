import type { WorkflowExportV1 } from "@/lib/workflow/export-schema";

/**
 * Descriptor for an imported code step that carries non-empty user code.
 * Used by `WorkflowIOOverlay` (plan 42-07) to render the second-step
 * confirmation Dialog before allowing import. The user must explicitly
 * trust each code step before the workflow is created on the server.
 *
 * Verified actionType literal: `code/run-code`
 * (lib/workflow/executor/executor.workflow.ts:1192).
 */
export type CodeStepDescriptor = {
  nodeId: string;
  label: string;
  /** First 80 chars of `node.data.config.code`, no trim, no escaping. */
  codePreview: string;
};

/**
 * Walk the parsed export payload and return one descriptor per node where
 * `data.config.actionType === "code/run-code"` AND `data.config.code` is a
 * non-empty trimmed string. Returns `[]` when no such nodes exist.
 *
 * SEC-05: This function is the source of truth for the UX-level confirmation
 * gate. Server-side, the import route accepts code-step nodes — the gate is
 * UX only because the server cannot distinguish "user-trusted" from
 * "user-unaware".
 */
export function findCodeStepsWithContent(
  payload: WorkflowExportV1
): CodeStepDescriptor[] {
  const out: CodeStepDescriptor[] = [];
  for (const node of payload.nodes) {
    const config = node.data.config as Record<string, unknown> | undefined;
    if (!config) {
      continue;
    }
    if (config.actionType !== "code/run-code") {
      continue;
    }
    const code = config.code;
    if (typeof code !== "string" || code.trim() === "") {
      continue;
    }
    out.push({
      nodeId: node.id,
      label: node.data.label,
      codePreview: code.slice(0, 80),
    });
  }
  return out;
}
