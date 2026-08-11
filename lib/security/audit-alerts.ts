import { captureMessage } from "@sentry/nextjs";
import { ErrorCategory, logSystemError } from "@/lib/logging";

/**
 * Audit actions that are irreversible or move funds/permissions and so warrant
 * an active signal (Sentry warning) on top of the passive log, so a responder
 * sees them promptly rather than only on a later trail review. The before/after
 * diff is deliberately NOT forwarded -- only identifiers -- so no secret or
 * payload leaves through the alert channel.
 */
const HIGH_RISK_ACTIONS = new Set<string>([
  "wallet.private_key_exported",
  "wallet.funds_withdrawn",
  "agentic_wallet.hmac_rotated",
  "agentic_wallet.linked",
  "safe_role.installed",
  "safe_role.updated",
  "safe_role_allowance.created",
  "safe_role_allowance.revoked",
  "org.deactivated",
  "account.deactivated",
]);

export function isHighRiskAuditAction(action: string): boolean {
  return HIGH_RISK_ACTIONS.has(action);
}

export type HighRiskAlert = {
  action: string;
  actorUserId: string | null;
  actorLabel?: string | null;
  organizationId: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
};

/**
 * Fan a high-risk audit action out to Sentry as a warning. Best-effort and
 * non-throwing: alerting must never break the audited action. No-op for
 * non-high-risk actions.
 */
export function alertHighRiskAudit(alert: HighRiskAlert): void {
  if (!HIGH_RISK_ACTIONS.has(alert.action)) {
    return;
  }
  try {
    captureMessage(`High-risk security action: ${alert.action}`, {
      level: "warning",
      tags: {
        audit_action: alert.action,
        organization_id: alert.organizationId ?? "none",
      },
      extra: {
        actorUserId: alert.actorUserId,
        actorLabel: alert.actorLabel ?? null,
        resourceType: alert.resourceType ?? null,
        resourceId: alert.resourceId ?? null,
      },
    });
  } catch (error) {
    logSystemError(
      ErrorCategory.INFRASTRUCTURE,
      "Failed to alert high-risk audit action",
      error,
      { action: alert.action }
    );
  }
}
