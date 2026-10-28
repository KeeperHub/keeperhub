import { NextResponse } from "next/server";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import {
  requireManager,
  resolveOrgAccess,
  settingsErrorResponse,
} from "@/lib/notifications/failure-alerts/route-auth";
import {
  loadOrgSettingsView,
  parseOrgSettings,
  requeueForEvaluation,
  saveOrgSettings,
} from "@/lib/notifications/failure-alerts/settings";
import { buildAuditMetadata, recordAuditEvent } from "@/lib/security/audit-log";

const ENDPOINT = "/api/organizations/[organizationId]/failure-alerts";

export async function GET(
  request: Request,
  context: { params: Promise<{ organizationId: string }> }
): Promise<NextResponse> {
  try {
    const { organizationId } = await context.params;
    const access = await resolveOrgAccess(request, organizationId);
    if (access instanceof NextResponse) {
      return access;
    }
    const view = await loadOrgSettingsView(organizationId);
    return NextResponse.json({
      ...view,
      canManage: access.canManage,
      viewerUserId: access.userId,
    });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[FailureAlerts] Failed to load settings",
      error,
      { endpoint: ENDPOINT }
    );
    return NextResponse.json(
      { error: "Failed to load settings" },
      { status: 500 }
    );
  }
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ organizationId: string }> }
): Promise<NextResponse> {
  try {
    const { organizationId } = await context.params;
    const access = await resolveOrgAccess(request, organizationId);
    if (access instanceof NextResponse) {
      return access;
    }
    const denied = requireManager(access);
    if (denied) {
      return denied;
    }

    const body = (await request.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const input = await parseOrgSettings(body, organizationId);
    await saveOrgSettings(organizationId, input, access.userId);
    await requeueForEvaluation(organizationId);

    await recordAuditEvent({
      actor: {
        userId: access.userId,
        organizationId,
        authMethod: access.authMethod,
        apiKeyId: access.apiKeyId,
      },
      action: "org.failure_alerts_changed",
      resourceType: "organization",
      resourceId: organizationId,
      after: {
        threshold: input.threshold,
        timeLimitMinutes: input.timeLimitMinutes,
        remindDaily: input.remindDaily,
        notifyRecovery: input.notifyRecovery,
        recipientUserIds: input.recipientUserIds,
        channels: input.channels.map((c) => ({
          kind: c.kind,
          integrationId: c.integrationId,
          destination: c.destination,
          role: c.role,
        })),
      },
      metadata: buildAuditMetadata(request),
    });

    const view = await loadOrgSettingsView(organizationId);
    return NextResponse.json({
      ...view,
      canManage: true,
      viewerUserId: access.userId,
    });
  } catch (error) {
    const handled = settingsErrorResponse(error);
    if (handled) {
      return handled;
    }
    logSystemError(
      ErrorCategory.DATABASE,
      "[FailureAlerts] Failed to save settings",
      error,
      { endpoint: ENDPOINT }
    );
    return NextResponse.json(
      { error: "Failed to save settings" },
      { status: 500 }
    );
  }
}
