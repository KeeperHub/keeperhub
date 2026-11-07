import { NextResponse } from "next/server";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import type { PauseChange } from "@/lib/notifications/failure-alerts/pause-copy";
import {
  authenticate,
  orgAccess,
  readJsonObject,
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

function pauseAction(
  change: PauseChange
): string {
  if (change === "resumed") {
    return "workflow.failure_alerts_resumed";
  }
  return change ? "workflow.failure_alerts_paused" : "workflow.failure_alerts_changed";
}

/** The workflow's failure notifications: org default, its override, its state. */
export async function GET(
  request: Request,
  context: { params: Promise<{ workflowId: string }> }
): Promise<NextResponse> {
  try {
    const { workflowId } = await context.params;
    // Auth first, so unknown and other-org ids answer the same.
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

/** Save the override; owners and admins only, since it can change who is alerted. */
export async function PUT(
  request: Request,
  context: { params: Promise<{ workflowId: string }> }
): Promise<NextResponse> {
  try {
    const { workflowId } = await context.params;
    // Auth first, so unknown and other-org ids answer the same.
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

    const body = await readJsonObject(request);
    if (body instanceof NextResponse) {
      return body;
    }
    const { rulesChanged, pauseChange, pauseBefore, pauseAfter, ...saved } =
      await saveWorkflowOverride({
      workflowId,
      organizationId: workflow.organizationId,
      userId: access.userId,
      body,
    });
    if (rulesChanged) {
      await requeueForEvaluation(workflow.organizationId, workflowId);
    }

    await recordAuditEvent({
      actor: {
        userId: access.userId,
        organizationId: workflow.organizationId,
        authMethod: access.authMethod,
        apiKeyId: access.apiKeyId,
      },
      // A pause gets its own action, with what it was and what it became.
      action: pauseAction(pauseChange),
      resourceType: "workflow",
      resourceId: workflowId,
      ...(pauseChange
        ? { before: { pause: pauseBefore }, after: { ...saved, pause: pauseAfter } }
        : { after: saved }),
      metadata: buildAuditMetadata(request),
    });

    const view = await loadWorkflowAlertView(workflow, access.userId);
    return NextResponse.json({ ...view, canManage: true, pauseChange });
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
