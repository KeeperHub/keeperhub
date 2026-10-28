import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isBillingEnabled } from "@/lib/billing/feature-flag";
import { isBillingLimitReached } from "@/lib/billing/limit-status";
import { ErrorCategory, logSystemWarn } from "@/lib/logging";
import { resolveOrganizationId } from "@/lib/middleware/auth-helpers";
import { isFailureAlertsEnabledForOrg } from "@/lib/notifications/failure-alerts/rollout";
import { loadInAppAlertState } from "@/lib/notifications/failure-alerts/settings";

export type NotificationType =
  | "billing_limit_reached"
  | "workflows_failing"
  | "failure_alerts_unreachable";

type NotificationStatusResponse = {
  unreadCount: number;
  types: NotificationType[];
  /** Alerts are on for this org (FAILURE_ALERTS_ROLLOUT); the UI hides them otherwise. */
  alertsEnabled: boolean;
};

const EMPTY_RESPONSE: NotificationStatusResponse = {
  unreadCount: 0,
  types: [],
  alertsEnabled: false,
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
    const activeMember = await auth.api.getActiveMember({
      headers: await headers(),
    });
    const role = activeMember?.role;

    if (
      isBillingEnabled() &&
      role === "owner" &&
      (await isBillingLimitReached(organizationId))
    ) {
      types.push("billing_limit_reached");
    }

    // Only owners and admins can act on a failing workflow or fix settings.
    if (role === "owner" || role === "admin") {
      // Its own catch, so a failure here never hides the billing notice.
      try {
        const alerts = await loadInAppAlertState(organizationId);
        if (alerts.failingWorkflows > 0) {
          types.push("workflows_failing");
        }
        if (alerts.unreachable) {
          types.push("failure_alerts_unreachable");
        }
      } catch (error) {
        logSystemWarn(
          ErrorCategory.DATABASE,
          "[notifications-status] failure-alert state unavailable",
          error
        );
      }
    }

    return NextResponse.json({
      unreadCount: types.length,
      types,
      alertsEnabled: isFailureAlertsEnabledForOrg(organizationId),
    });
  } catch (error) {
    logSystemWarn(
      ErrorCategory.INFRASTRUCTURE,
      "[notifications-status] degraded; returning empty response",
      error
    );
    return NextResponse.json(EMPTY_RESPONSE);
  }
}
