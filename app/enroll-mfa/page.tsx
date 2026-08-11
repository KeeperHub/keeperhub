import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import {
  decodePendingSignupCookie,
  readPendingSignupCookie,
} from "@/lib/pending-signup-cookie";
import { sanitizeNextPath } from "@/lib/sanitize-next-path";
import { EnrollMfaForm } from "./enroll-mfa-form";

/**
 * Forced TOTP enrollment page. Two ways to land here:
 *
 *   1. Existing signed-in user whose two_factor_enabled = false.
 *      The proxy gate keeps routing them here on every request
 *      until enrollment completes.
 *   2. Brand-new credential or OAuth signup that hasn't enrolled
 *      yet. They land here with a signed `pending_signup_mfa` cookie
 *      and NO session. The session is minted for the first time
 *      inside the enroll route once they finish the 3-step wizard.
 */
export default async function EnrollMfaPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}): Promise<React.ReactElement> {
  const requestHeaders = await headers();
  const params = await searchParams;
  const next = sanitizeNextPath(params.next);

  // 1. Pending-signup path. Valid signed cookie, no session yet.
  const pendingCookie = readPendingSignupCookie(requestHeaders);
  if (pendingCookie) {
    const secret = process.env.BETTER_AUTH_SECRET;
    if (secret) {
      const decoded = decodePendingSignupCookie(pendingCookie, secret);
      if (decoded.ok) {
        return (
          <main className="flex min-h-screen items-center justify-center bg-background p-6">
            <EnrollMfaForm
              mode="pending-signup"
              next={sanitizeNextPath(decoded.payload.redirect ?? next)}
            />
          </main>
        );
      }
    }
    // Fall through; an expired or tampered pending cookie is treated
    // as if no cookie was present.
  }

  // 2. Already-signed-in user who hasn't enrolled yet.
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session?.user) {
    redirect("/");
  }
  const user = session.user as { twoFactorEnabled?: boolean | null };
  if (user.twoFactorEnabled === true) {
    redirect("/");
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <EnrollMfaForm mode="signed-in" next={next} />
    </main>
  );
}
