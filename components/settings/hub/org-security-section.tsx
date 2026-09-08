"use client";

import { MfaEnforcementSection } from "@/components/organization/mfa-enforcement-section";
import { EmptyState, SectionHeader, SettingsCard } from "./section";
import { useSettingsContext } from "./settings-context";

export function OrgSecuritySection(): React.ReactElement {
  const { organizationId, isAdmin, isOwner } = useSettingsContext();

  return (
    <>
      <SectionHeader
        description="Security rules that apply to everyone in this organization."
        title="Organization security"
      />

      {isAdmin && organizationId ? (
        <SettingsCard
          description="Require every member of this organization to enrol a second factor before they can run workflows."
          title="Organization MFA enforcement"
        >
          <MfaEnforcementSection
            canEdit={isOwner}
            organizationId={organizationId}
          />
        </SettingsCard>
      ) : (
        <SettingsCard title="Organization MFA enforcement">
          <EmptyState>
            Only organization admins and owners can see this.
          </EmptyState>
        </SettingsCard>
      )}
    </>
  );
}
