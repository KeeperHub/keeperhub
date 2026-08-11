import { sendApiKeyChangeEmail } from "@/lib/email";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { getDeliverableEmail } from "@/lib/security/notification-email";

/**
 * Out-of-band notification for API key create/revoke. Unlike the new-IP
 * courtesy mail this needs no Redis dedup: a create or revoke is a single
 * deliberate user action, not a per-request fan-out, so each event should send
 * exactly once. Fire-and-forget; the route must never block on SendGrid.
 *
 * Takes the acting user's id + login email and resolves the deliverable
 * address itself: email/TOTP users get their login email, wallet users get the
 * verified step-up email they enrolled (and are skipped if they enrolled none).
 */
export type ApiKeyChangeNotification = {
  userId: string;
  loginEmail: string | null | undefined;
  action: "created" | "revoked";
  tokenName: string | null;
  keyPrefix: string;
  when: Date;
};

export function notifyApiKeyChange(
  notification: ApiKeyChangeNotification
): void {
  const deliver = async (): Promise<void> => {
    const email = await getDeliverableEmail(
      notification.userId,
      notification.loginEmail
    );
    if (!email) {
      return;
    }
    await sendApiKeyChangeEmail({
      email,
      action: notification.action,
      tokenName: notification.tokenName,
      keyPrefix: notification.keyPrefix,
      when: notification.when,
    });
  };
  deliver().catch((err: unknown) => {
    logSystemError(
      ErrorCategory.EXTERNAL_SERVICE,
      "API key change notification failed",
      err,
      { userId: notification.userId, action: notification.action }
    );
  });
}
