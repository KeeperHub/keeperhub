"use client";

import { authClient } from "@/lib/auth-client";
import { useCachedSection } from "./use-cached-section";

export type UserInvitation = {
  id: string;
  email: string;
  status: string;
  organizationName?: string;
};

/** Invitations addressed to the signed-in user, across every organization. */
export function useUserInvitations(): {
  invitations: UserInvitation[];
  loading: boolean;
} {
  const section = useCachedSection<UserInvitation[]>(
    "user-invitations",
    async () => {
      const result = await authClient.organization.listUserInvitations();
      const list = Array.isArray(result.data) ? result.data : [];
      return (list as UserInvitation[]).filter(
        (inv) => inv.status === "pending"
      );
    }
  );

  return { invitations: section.data ?? [], loading: section.loading };
}
