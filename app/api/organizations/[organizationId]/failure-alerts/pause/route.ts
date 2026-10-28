import { NextResponse } from "next/server";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import {
  pauseOrgAlerts,
  resumeOrgAlerts,
} from "@/lib/notifications/failure-alerts/org-pause";
import {
  type OrgAccess,
  requireManager,
  resolveOrgAccess,
  settingsErrorResponse,
} from "@/lib/notifications/failure-alerts/route-auth";
import { loadOrgSettingsView } from "@/lib/notifications/failure-alerts/settings";
import { loadOrgMembers } from "@/lib/notifications/org-recipients";
import { buildAuditMetadata, recordAuditEvent } from "@/lib/security/audit-log";

const ENDPOINT = "/api/organizations/[organizationId]/failure-alerts/pause";

type Params = { params: Promise<{ organizationId: string }> };

/** Who to name in the pause notice: their reachable email, or their name. */
async function actorLabel(
  organizationId: string,
  userId: string
): Promise<string | null> {
  const me = (await loadOrgMembers(organizationId)).find(
    (m) => m.userId === userId
  );
  return me?.deliverable ?? me?.name ?? null;
}

async function handle(
  request: Request,
  context: Params,
  action: (organizationId: string, access: OrgAccess) => Promise<unknown>
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
    const after = await action(organizationId, access);
    await recordAuditEvent({
      actor: {
        userId: access.userId,
        organizationId,
        authMethod: access.authMethod,
        apiKeyId: access.apiKeyId,
      },
      action:
        request.method === "DELETE"
          ? "org.failure_alerts_resumed"
          : "org.failure_alerts_paused",
      resourceType: "organization",
      resourceId: organizationId,
      after,
      metadata: buildAuditMetadata(request),
    });
    const view = await loadOrgSettingsView(organizationId, access.userId);
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
      "[FailureAlerts] Failed to change the org pause",
      error,
      { endpoint: ENDPOINT }
    );
    return NextResponse.json(
      { error: "Failed to change the pause" },
      { status: 500 }
    );
  }
}

/** Pause every alert of the organization until a time (maintenance). Owners and admins. */
export function PUT(request: Request, context: Params): Promise<NextResponse> {
  return handle(request, context, async (organizationId, access) => {
    const body = (await request.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    await pauseOrgAlerts({
      organizationId,
      until: body.until,
      reason: body.reason,
      byEmail: await actorLabel(organizationId, access.userId),
      now: new Date(),
    });
    return { until: body.until, reason: body.reason ?? null };
  });
}

/** Turn alerts back on now. */
export function DELETE(
  request: Request,
  context: Params
): Promise<NextResponse> {
  return handle(request, context, async (organizationId, access) => {
    await resumeOrgAlerts({
      organizationId,
      byEmail: await actorLabel(organizationId, access.userId),
      now: new Date(),
    });
    return { paused: false };
  });
}
