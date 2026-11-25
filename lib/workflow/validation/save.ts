import {
  type ActionConfigValidationResult,
  validateWorkflowActionConfigs,
  type WorkflowNodeForValidation,
} from "@/lib/workflow/validation/action-config";
import {
  reconcileSendModeKeys,
  type SendModeSaveOptions,
  validateSendModeForSave,
} from "@/lib/workflow/validation/send-mode";

/**
 * Every config check a workflow save runs: the action configs and Send as.
 * On an update the Send as keys are reconciled first (see reconcileSendModeKeys).
 */
export async function validateWorkflowNodesForSave(
  nodes: WorkflowNodeForValidation[],
  options: SendModeSaveOptions = {}
): Promise<ActionConfigValidationResult> {
  if (options.savedNodes) {
    reconcileSendModeKeys(nodes, options.savedNodes);
  }
  const actionConfigs = validateWorkflowActionConfigs(nodes, {
    savedNodes: options.savedNodes,
  });
  const sendModes = await validateSendModeForSave(nodes, options);
  const issues = [...actionConfigs.issues, ...sendModes.issues];
  return { valid: issues.length === 0, issues };
}
