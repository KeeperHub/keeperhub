import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { SiteFooter } from "@/components/site/site-footer";
import { WelcomeAuth } from "@/components/welcome/welcome-auth";
import { auth } from "@/lib/auth";
import { isAnonymousUser } from "@/lib/is-anonymous";

/**
 * Welcome landing shown to visitors without a real session. A signed-in user
 * who reaches it directly is bounced home, where the onboarding gate takes over.
 */
export default async function WelcomePage(): Promise<React.ReactElement> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (session?.user && !isAnonymousUser(session.user)) {
    redirect("/");
  }

  return (
    // Own scroll container, because globals.css sets `html, body { overflow:
    // hidden }` for the app shell - the workflow canvas must not scroll the
    // page. Without this the footer below still renders into the DOM, so a
    // crawler reads it, but no user can ever scroll to it. Content only a
    // crawler can see is the cloaking this work set out not to do.
    // components/activity/activity-page.tsx solves the same problem the same way.
    <div className="h-dvh overflow-y-auto">
      <main className="flex min-h-dvh items-center justify-center bg-background p-6">
        <WelcomeAuth />
      </main>
      <SiteFooter />
    </div>
  );
}
