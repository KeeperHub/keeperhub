"use client";

import { OrgFailureAlertsSection } from "@/components/failure-alerts/org-failure-alerts-section";
import { useSettingsContext } from "./settings-context";

export function AlertsSection(): React.ReactElement {
  const { organizationId } = useSettingsContext();
  // Remounted per organization, so no draft carries over to another one.
  return (
    <OrgFailureAlertsSection
      key={organizationId ?? "none"}
      organizationId={organizationId}
    />
  );
}
