"use client";

import { ExecutionDigestSection } from "@/components/organization/execution-digest-section";
import { SectionHeader, SettingsCard } from "./section";
import { useSettingsContext } from "./settings-context";
import { FormSkeleton } from "./skeletons";

export function NotificationsSection(): React.ReactElement {
  const { organizationId, isOwner } = useSettingsContext();

  return (
    <>
      <SectionHeader
        description="Recurring emails about what your workflows did, and who on the team receives them."
        title="Notifications"
      />
      <SettingsCard
        description="A rollup of executions, failures and gas spend."
        title="Execution digest"
      >
        {organizationId ? (
          <ExecutionDigestSection
            canManageBilling={isOwner}
            organizationId={organizationId}
          />
        ) : (
          <FormSkeleton rows={2} />
        )}
      </SettingsCard>
    </>
  );
}
