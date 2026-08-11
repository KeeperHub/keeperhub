import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { isAnonymousUser } from "@/lib/is-anonymous";

/**
 * Server-side gate for the onboarding wizard steps: a real (non-anonymous)
 * session is required. Anonymous or signed-out visitors are sent to the
 * welcome landing to authenticate first.
 */
export async function requireOnboardingSession(): Promise<void> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user || isAnonymousUser(session.user)) {
    redirect("/welcome");
  }
}
