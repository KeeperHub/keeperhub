import { NextResponse } from "next/server";
import { isBillingEnabled } from "@/lib/billing/feature-flag";
import { isBillingLimitReached } from "@/lib/billing/limit-status";
import { ErrorCategory, logSystemWarn } from "@/lib/logging";
import { getDualAuthContext } from "@/lib/middleware/auth-helpers";
import { isFailureAlertsEnabledForOrg } from "@/lib/notifications/failure-alerts/rollout";
import { loadInAppAlertState } from "@/lib/notifications/failure-alerts/settings";
import { getOrgRole } from "@/lib/security/org-role";

export type NotificationType =
  | "billing_limit_reached"
  | "workflows_failing"
  | "failure_alerts_unreachable";

type NotificationStatusResponse = {
  unreadCount: number;
  types: NotificationType[];
  /** Alerts are on for this org (FAILURE_ALERTS_ROLLOUT); the UI hides them otherwise. */
  alertsEnabled: boolean;
  /** When the org-wide alert pause ends (ISO); owners and admins only. */
  alertsPausedUntil: string | null;
};

const EMPTY_RESPONSE: NotificationStatusResponse = {
  unreadCount: 0,
  types: [],
  alertsEnabled: false,
  alertsPausedUntil: null,
};

export async function GET(
  request: Request
): Promise<NextResponse<NotificationStatusResponse>> {
  try {
    // The caller names its org in X-Organization-Id; a non-member gets an error here.
    const authContext = await getDualAuthContext(request);
    if (
      "error" in authContext ||
      !authContext.userId ||
      !authContext.organizationId
    ) {
      return NextResponse.json(EMPTY_RESPONSE);
    }
    const { organizationId } = authContext;
    const role = await getOrgRole(authContext.userId, organizationId);
    if (!role) {
      return NextResponse.json(EMPTY_RESPONSE);
    }

    const types: NotificationType[] = [];
    let alertsPausedUntil: string | null = null;

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
        alertsPausedUntil = alerts.pausedUntil;
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
      alertsPausedUntil,
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
