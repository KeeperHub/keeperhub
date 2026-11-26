import {
  type ActionConfigValidationResult,
  validateWorkflowActionConfigs,
  type WorkflowNodeForValidation,
} from "@/lib/workflow/validation/action-config";
import {
  reconcileSendModeKeys,
  type SendModeSaveOptions,
  validateSendModeForSave,
  writeLegacySendModeKey,
} from "@/lib/workflow/validation/send-mode";

/**
 * Every config check a workflow save runs: the action configs and Send as.
 * On an update the Send as keys are reconciled first; a valid save then fills
 * a missing `usePrivateMempool` beside every known `sendMode`.
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
  if (issues.length === 0) {
    writeLegacySendModeKey(nodes);
  }
  return { valid: issues.length === 0, issues };
}
