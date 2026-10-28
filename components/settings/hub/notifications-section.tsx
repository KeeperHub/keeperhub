"use client";

import { NotificationHistory } from "@/components/failure-alerts/notification-history";
import { OrgFailureAlertsSection } from "@/components/failure-alerts/org-failure-alerts-section";
import { ExecutionDigestSection } from "@/components/organization/execution-digest-section";
import { SectionHeader, SettingsCard } from "./section";
import { useSettingsContext } from "./settings-context";
import { FormSkeleton } from "./skeletons";

export function NotificationsSection(): React.ReactElement {
  const { organizationId, isOwner } = useSettingsContext();

  return (
    <>
      <SectionHeader
        description="Alerts and recurring emails about your workflows, and who on the team receives them."
        title="Notifications"
      />
      <SettingsCard
        description="Tells your team when a workflow that runs on its own keeps failing."
        title="Workflow failure notifications"
      >
        {organizationId ? (
          <OrgFailureAlertsSection organizationId={organizationId} />
        ) : (
          <FormSkeleton rows={4} />
        )}
      </SettingsCard>
      <SettingsCard
        description="What was sent, where, and whether it arrived."
        title="Recent notifications"
      >
        {organizationId ? (
          <NotificationHistory organizationId={organizationId} />
        ) : (
          <FormSkeleton rows={3} />
        )}
      </SettingsCard>
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
