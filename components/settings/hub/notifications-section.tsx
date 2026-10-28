"use client";

import Link from "next/link";
import { ExecutionDigestSection } from "@/components/organization/execution-digest-section";
import { SectionHeader, SettingsCard } from "./section";
import { useSettingsContext } from "./settings-context";
import { FormSkeleton } from "./skeletons";

export function NotificationsSection(): React.ReactElement {
  const { organizationId, isOwner } = useSettingsContext();

  return (
    <>
      <SectionHeader
        description="Recurring emails about your workflows, and who on the team receives them."
        title="Notifications"
      />
      <SettingsCard title="Workflow failure alerts">
        <p className="text-muted-foreground text-sm">
          Workflow failure alerts are under{" "}
          <Link
            className="text-foreground underline underline-offset-4"
            href={
              organizationId
                ? `/settings/${organizationId}/alerts`
                : "/settings"
            }
          >
            Alerts
          </Link>
          .
        </p>
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
