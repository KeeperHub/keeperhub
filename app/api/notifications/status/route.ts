import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isBillingEnabled } from "@/lib/billing/feature-flag";
import { isBillingLimitReached } from "@/lib/billing/limit-status";
import { ErrorCategory, logSystemWarn } from "@/lib/logging";
import { resolveOrganizationId } from "@/lib/middleware/auth-helpers";

export type NotificationType = "billing_limit_reached";

type NotificationStatusResponse = {
  unreadCount: number;
  types: NotificationType[];
};

const EMPTY_RESPONSE: NotificationStatusResponse = {
  unreadCount: 0,
  types: [],
};

export async function GET(
  request: Request
): Promise<NextResponse<NotificationStatusResponse>> {
  try {
    const authContext = await resolveOrganizationId(request);
    if ("error" in authContext) {
      return NextResponse.json(EMPTY_RESPONSE);
    }
    const { organizationId } = authContext;

    const types: NotificationType[] = [];

    if (isBillingEnabled()) {
      const activeMember = await auth.api.getActiveMember({
        headers: await headers(),
      });
      const isOwner = activeMember?.role === "owner";
      if (isOwner && (await isBillingLimitReached(organizationId))) {
        types.push("billing_limit_reached");
      }
    }

    return NextResponse.json({ unreadCount: types.length, types });
  } catch (error) {
    logSystemWarn(
      ErrorCategory.INFRASTRUCTURE,
      "[notifications-status] degraded; returning empty response",
      error
    );
    return NextResponse.json(EMPTY_RESPONSE);
  }
}
