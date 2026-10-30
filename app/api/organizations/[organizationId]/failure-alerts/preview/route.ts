import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { organization } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import {
  appBaseUrl,
  renderSample,
  type SampleKind,
} from "@/lib/notifications/failure-alerts/messages";
import { resolveOrgAccess } from "@/lib/notifications/failure-alerts/route-auth";
import type { MessagePreview } from "@/lib/notifications/failure-alerts/view-types";

const SAMPLES = new Set<SampleKind>(["alert", "missed", "paused", "recovery"]);

/** Each channel's message, rendered by the real message code. Any member. */
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
    const requested = new URL(request.url).searchParams.get("sample");
    const sample = SAMPLES.has(requested as SampleKind)
      ? (requested as SampleKind)
      : "alert";
    const [org] = await db
      .select({ name: organization.name })
      .from(organization)
      .where(eq(organization.id, organizationId))
      .limit(1);
    const message = renderSample(
      {
        orgName: org?.name ?? "Your organization",
        organizationId,
        appUrl: appBaseUrl(),
      },
      sample
    );
    const preview: MessagePreview = {
      sample,
      subject: message.subject,
      html: message.html,
      chat: message.chat,
      pagerDutySummary: message.summary,
    };
    return NextResponse.json(preview);
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[FailureAlerts] Could not render a message preview",
      error,
      { endpoint: "/api/organizations/[organizationId]/failure-alerts/preview" }
    );
    return NextResponse.json(
      { error: "Could not load the preview" },
      { status: 500 }
    );
  }
}
