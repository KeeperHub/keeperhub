import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import {
  decodePendingOauthMfaCookie,
  readPendingOauthMfaCookie,
} from "@/lib/oauth-mfa-cookie";
import { sanitizeNextPath } from "@/lib/sanitize-next-path";
import { VerifyMfaForm } from "./verify-mfa-form";

/**
 * Step-up MFA verification page. Two ways to land here:
 *
 *   1. Signed-in user whose session has `requires_mfa = true` (the
 *      session.create.before hook flips it on every fresh session of a
 *      TOTP-enrolled user). Verify clears the flag and lets them on.
 *
 *   2. OAuth user who just bounced through /api/auth/callback/<provider>
 *      and got their session immediately destroyed because they have
 *      TOTP enrolled. They carry only the signed `pending_oauth_mfa`
 *      cookie, no session at all. Verify mints a real session for the
 *      first time.
 *
 * The page detects which case applies and renders the form in the
 * matching mode.
 */
export default async function VerifyMfaPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}): Promise<React.ReactElement> {
  const requestHeaders = await headers();
  const params = await searchParams;
  const next = sanitizeNextPath(params.next);

  // 1. OAuth-deferred path. Pending cookie present + valid + unexpired.
  const pendingValue = readPendingOauthMfaCookie(requestHeaders);
  if (pendingValue) {
    const secret = process.env.BETTER_AUTH_SECRET;
    if (secret) {
      const decoded = decodePendingOauthMfaCookie(pendingValue, secret);
      if (decoded.ok) {
        return (
          <main className="flex min-h-screen items-center justify-center bg-background p-6">
            <VerifyMfaForm
              mode="oauth"
              next={sanitizeNextPath(decoded.payload.redirect)}
            />
          </main>
        );
      }
    }
    // Fall through to session check; expired or tampered pending
    // cookie just means we treat them as not-OAuth-pending.
  }

  // 2. Already-signed-in step-up.
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session?.user) {
    redirect("/");
  }
  const sessionRow = session.session as { requiresMfa?: boolean };
  if (sessionRow.requiresMfa !== true) {
    redirect("/");
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <VerifyMfaForm mode="stepup" next={next} />
    </main>
  );
}
