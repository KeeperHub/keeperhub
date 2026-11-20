"use client";

import Link from "next/link";
import { ExecutionDigestSection } from "@/components/organization/execution-digest-section";
import { Button } from "@/components/ui/button";
import { SectionHeader, SettingsCard } from "./section";
import { useSettingsContext } from "./settings-context";
import { FormSkeleton } from "./skeletons";

export function NotificationsSection(): React.ReactElement {
  const { organizationId, isOwner, alertsEnabled } = useSettingsContext();

  return (
    <>
      <SectionHeader
        description="Scheduled summary emails about your workflows."
        title="Notifications"
      />
      {alertsEnabled === true && organizationId && (
        <SettingsCard title="Failure alerts">
          <div className="flex flex-col gap-3 @xl/settings:flex-row @xl/settings:items-center @xl/settings:justify-between">
            <p className="text-muted-foreground text-sm">
              Failure alerts now have their own page.
            </p>
            <Button
              asChild
              className="w-full @xl/settings:w-auto"
              size="sm"
              variant="outline"
            >
              <Link href={`/settings/${organizationId}/alerts`}>
                Open Alerts
              </Link>
            </Button>
          </div>
        </SettingsCard>
      )}
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
