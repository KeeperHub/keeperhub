"use client";

import { useMemo } from "react";
import type { RunSource } from "@/lib/analytics/types";
import { useAlertsEnabled } from "@/lib/hooks/use-notifications";
import { useOrganization } from "@/lib/hooks/use-organization";

const WITHOUT_ALERTS: RunSource[] = ["workflow", "direct"];

/** The sources to ask for: alert rows only where alerts are switched on. */
export function useRunSources(picked: RunSource[]): RunSource[] {
  const { organization } = useOrganization();
  const alertsEnabled = useAlertsEnabled(organization?.id);
  return useMemo(() => {
    if (alertsEnabled === true) {
      return picked;
    }
    const kept = picked.filter((source) => source !== "notification");
    return kept.length > 0 ? kept : WITHOUT_ALERTS;
  }, [alertsEnabled, picked]);
}
