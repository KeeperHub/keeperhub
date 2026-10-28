import { NextResponse } from "next/server";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import {
  authenticate,
  orgAccess,
  requireManager,
  settingsErrorResponse,
} from "@/lib/notifications/failure-alerts/route-auth";
import { requeueForEvaluation } from "@/lib/notifications/failure-alerts/settings";
import {
  loadWorkflowAlertView,
  loadWorkflowForAlerts,
  saveWorkflowOverride,
} from "@/lib/notifications/failure-alerts/workflow-settings";
import { buildAuditMetadata, recordAuditEvent } from "@/lib/security/audit-log";

const ENDPOINT = "/api/workflows/[workflowId]/failure-alerts";

/** The workflow's failure notifications: org default, its override, its state. */
export async function GET(
  request: Request,
  context: { params: Promise<{ workflowId: string }> }
): Promise<NextResponse> {
  try {
    const { workflowId } = await context.params;
    // Authenticate before looking the workflow up, so an unknown id and one
    // in another org answer the same way.
    const auth = await authenticate(request);
    if (auth instanceof NextResponse) {
      return auth;
    }
    const workflow = await loadWorkflowForAlerts(workflowId);
    const access = workflow
      ? await orgAccess(auth, workflow.organizationId)
      : null;
    if (!(workflow && access) || access instanceof NextResponse) {
      return NextResponse.json({ error: "Workflow not found" }, { status: 404 });
    }
    const view = await loadWorkflowAlertView(workflow, access.userId);
    return NextResponse.json({ ...view, canManage: access.canManage });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[FailureAlerts] Failed to load workflow settings",
      error,
      { endpoint: ENDPOINT }
    );
    return NextResponse.json({ error: "Failed to load settings" }, { status: 500 });
  }
}

/**
 * Save the override. Owners and admins only for now: an override can lower
 * the threshold or add recipients, which is the org's call.
 */
export async function PUT(
  request: Request,
  context: { params: Promise<{ workflowId: string }> }
): Promise<NextResponse> {
  try {
    const { workflowId } = await context.params;
    // Authenticate before looking the workflow up, so an unknown id and one
    // in another org answer the same way.
    const auth = await authenticate(request);
    if (auth instanceof NextResponse) {
      return auth;
    }
    const workflow = await loadWorkflowForAlerts(workflowId);
    const access = workflow
      ? await orgAccess(auth, workflow.organizationId)
      : null;
    if (!(workflow && access) || access instanceof NextResponse) {
      return NextResponse.json({ error: "Workflow not found" }, { status: 404 });
    }
    const denied = requireManager(access);
    if (denied) {
      return denied;
    }

    const body = (await request.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const saved = await saveWorkflowOverride({
      workflowId,
      organizationId: workflow.organizationId,
      userId: access.userId,
      body,
    });
    await requeueForEvaluation(workflow.organizationId, workflowId);

    await recordAuditEvent({
      actor: {
        userId: access.userId,
        organizationId: workflow.organizationId,
        authMethod: access.authMethod,
        apiKeyId: access.apiKeyId,
      },
      action: "workflow.failure_alerts_changed",
      resourceType: "workflow",
      resourceId: workflowId,
      after: saved,
      metadata: buildAuditMetadata(request),
    });

    const view = await loadWorkflowAlertView(workflow, access.userId);
    return NextResponse.json({ ...view, canManage: true });
  } catch (error) {
    const handled = settingsErrorResponse(error);
    if (handled) {
      return handled;
    }
    logSystemError(
      ErrorCategory.DATABASE,
      "[FailureAlerts] Failed to save workflow settings",
      error,
      { endpoint: ENDPOINT }
    );
    return NextResponse.json({ error: "Failed to save settings" }, { status: 500 });
  }
}
