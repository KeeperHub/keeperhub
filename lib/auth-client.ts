import {
  anonymousClient,
  emailOTPClient,
  organizationClient,
  siweClient,
  twoFactorClient,
} from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { ac, orgRoles } from "@/lib/auth-access-control";

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
