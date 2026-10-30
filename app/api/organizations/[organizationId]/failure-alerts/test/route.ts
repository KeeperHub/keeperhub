import { NextResponse } from "next/server";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import {
  requireManager,
  resolveOrgAccess,
  settingsErrorResponse,
} from "@/lib/notifications/failure-alerts/route-auth";
import { CHANNEL_KINDS } from "@/lib/notifications/failure-alerts/settings";
import { sendTest } from "@/lib/notifications/failure-alerts/test-send";
import type { TestRequest } from "@/lib/notifications/failure-alerts/view-types";
import { buildAuditMetadata, recordAuditEvent } from "@/lib/security/audit-log";

function parseRequest(body: Record<string, unknown>): TestRequest | null {
  if (body.channel === "email") {
    return {
      channel: "email",
      to: body.to === "recipients" ? "recipients" : "me",
      recipientUserIds: Array.isArray(body.recipientUserIds)
        ? (body.recipientUserIds as unknown[]).filter(
            (id): id is string => typeof id === "string"
          )
        : undefined,
    };
  }
  const kind = CHANNEL_KINDS.find((k) => k === body.channel);
  if (!kind || typeof body.integrationId !== "string") {
    return null;
  }
  return {
    channel: kind,
    integrationId: body.integrationId,
    destination: typeof body.destination === "string" ? body.destination : "",
    channelId: typeof body.channelId === "string" ? body.channelId : undefined,
    pagerDutyMode: body.pagerDutyMode === "page" ? "page" : "change",
  };
}

/** Test a saved or unsaved channel via the real senders. Owners and admins; rate limited. */
export async function POST(
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
    const testRequest = parseRequest(body);
    if (!testRequest) {
      return NextResponse.json(
        { error: "Pick a channel and a connection to test." },
        { status: 400 }
      );
    }

    const result = await sendTest({
      organizationId,
      userId: access.userId,
      request: testRequest,
    });

    await recordAuditEvent({
      actor: {
        userId: access.userId,
        organizationId,
        authMethod: access.authMethod,
        apiKeyId: access.apiKeyId,
      },
      action: "org.failure_alert_tested",
      resourceType: "organization",
      resourceId: organizationId,
      after: {
        channel: testRequest.channel,
        delivered: result.delivered,
        status: result.status ?? null,
        ...(testRequest.channel === "pagerduty"
          ? { pagerDutyMode: testRequest.pagerDutyMode }
          : {}),
      },
      metadata: buildAuditMetadata(request),
    });

    return NextResponse.json(result);
  } catch (error) {
    const handled = settingsErrorResponse(error);
    if (handled) {
      return handled;
    }
    logSystemError(
      ErrorCategory.EXTERNAL_SERVICE,
      "[FailureAlerts] Test send failed",
      error,
      { endpoint: "/api/organizations/[organizationId]/failure-alerts/test" }
    );
    return NextResponse.json(
      { error: "The test could not be sent" },
      { status: 500 }
    );
  }
}
