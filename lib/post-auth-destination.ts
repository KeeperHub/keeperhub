import { authClient } from "@/lib/auth-client";

/**
 * Where to send a user immediately after they sign in. A signed-in user who has
 * not finished onboarding goes straight into the wizard; everyone else goes to
 * the canvas. Deciding here -- from the freshly-set session -- instead of
 * bouncing through "/" avoids a canvas flash before the welcome redirect.
 */
export async function resolvePostAuthDestination(): Promise<string> {
  try {
    const { data } = await authClient.getSession();
    const onboardingDone =
      (data?.user as { onboardingCompleted?: boolean } | undefined)
        ?.onboardingCompleted === true;
    return onboardingDone ? "/" : "/welcome/create-org";
  } catch {
    return "/welcome/create-org";
  }
}
