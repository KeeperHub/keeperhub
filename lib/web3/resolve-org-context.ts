import "server-only";

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { workflowExecutions } from "@/lib/db/schema";
import { ErrorCategory, logUserError } from "@/lib/logging";
import { getErrorMessage } from "@/lib/utils";
import { getOrganizationIdFromExecution } from "@/lib/workflow/executor/helpers";

type WorkflowContext = {
  executionId?: string;
  organizationId?: string;
};

/**
 * Resolve organizationId and userId from context.
 * When _context.organizationId is provided (direct execution), skip workflowExecutions lookup.
 * When _context.executionId is provided (workflow execution), derive org and user from execution.
 */
export async function resolveOrganizationContext(
  _context: WorkflowContext,
  logTag: string,
  actionName: string
): Promise<
  | { success: true; organizationId: string; userId: string | undefined }
  | { success: false; error: string }
> {
  let organizationId: string;

  if (_context.organizationId) {
    organizationId = _context.organizationId;
  } else {
    if (!_context.executionId) {
      return {
        success: false,
        error: "Execution ID is required to identify the organization",
      };
    }
    try {
      organizationId = await getOrganizationIdFromExecution(
        _context.executionId
      );
    } catch (error) {
      logUserError(
        ErrorCategory.VALIDATION,
        `${logTag} Failed to get organization ID`,
        error,
        { plugin_name: "web3", action_name: actionName }
      );
      return {
        success: false,
        error: `Failed to get organization ID: ${getErrorMessage(error)}`,
      };
    }
  }

  // Direct execution: no userId needed, use chain default RPC
  if (_context.organizationId) {
    return { success: true, organizationId, userId: undefined };
  }

  // Workflow execution: look up userId for RPC preferences
  const executionId = _context.executionId;
  if (!executionId) {
    return {
      success: false,
      error: "Execution ID is required for workflow execution context",
    };
  }

  try {
    const execution = await db
      .select({ userId: workflowExecutions.userId })
      .from(workflowExecutions)
      .where(eq(workflowExecutions.id, executionId))
      .then((rows) => rows[0]);
    if (!execution) {
      throw new Error("Execution not found");
    }
    return { success: true, organizationId, userId: execution.userId };
  } catch (error) {
    logUserError(
      ErrorCategory.VALIDATION,
      `${logTag} Failed to get user ID`,
      error,
      { plugin_name: "web3", action_name: actionName }
    );
    return {
      success: false,
      error: `Failed to get user ID: ${getErrorMessage(error)}`,
    };
  }
}
