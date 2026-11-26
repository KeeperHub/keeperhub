import {
  anonymousClient,
  emailOTPClient,
  organizationClient,
  siweClient,
  twoFactorClient,
} from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { ac, orgRoles } from "@/lib/auth-access-control";
import { captchaFetchOptions } from "@/lib/turnstile-token";

export const authClient = createAuthClient({
  baseURL:
    typeof window === "undefined"
      ? "http://localhost:3000"
      : window.location.origin,
  plugins: [
    anonymousClient(),
    emailOTPClient(),
    siweClient(),
    twoFactorClient(),
    organizationClient({
      ac,
      roles: orgRoles,
    }),
  ],
});

export const { signIn, signOut, signUp, useSession } = authClient;

/** Anonymous sign-in, carrying the Turnstile token the server requires. */
export async function signInAnonymously(): Promise<
  Awaited<ReturnType<typeof authClient.signIn.anonymous>>
> {
  const fetchOptions = await captchaFetchOptions();
  return await authClient.signIn.anonymous(
    fetchOptions ? { fetchOptions } : undefined
  );
}
