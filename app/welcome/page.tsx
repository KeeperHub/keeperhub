import { headers } from "next/headers";
import { redirect } from "next/navigation";
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
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <WelcomeAuth />
    </main>
  );
}
