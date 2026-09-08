"use client";

import { DeactivateAccountSection } from "@/components/settings/delete-account-section";
import { ProfileForm } from "./account/profile-form";
import { useAccount } from "./hooks/use-account";
import { useUserInvitations } from "./hooks/use-user-invitations";
import { InvitationsCard } from "./invitations-card";
import { SectionHeader, SettingsCard } from "./section";

export function ProfileSection(): React.ReactElement {
  const invitations = useUserInvitations();
  const account = useAccount();

  return (
    <>
      <SectionHeader
        description="Your name and the email you sign in with."
        title="Profile"
      />

      <SettingsCard title="Account details">
        <ProfileForm account={account} loading={account.loading} />
      </SettingsCard>

      <InvitationsCard
        description="Organizations that have invited you to join, waiting on you to accept or decline."
        emptyLabel="No organization has invited you."
        loading={invitations.loading}
        reviewHref={(id) => `/accept-invite/${id}`}
        rows={invitations.invitations.map((inv) => ({
          id: inv.id,
          label: inv.organizationName ?? "An organization",
        }))}
        title="Organization invitations"
      />

      <SettingsCard
        className="border-destructive/30"
        description="Deactivating stops every workflow in every organization you own. This cannot be undone."
        title="Deactivate account"
      >
        <DeactivateAccountSection />
      </SettingsCard>
    </>
  );
}
