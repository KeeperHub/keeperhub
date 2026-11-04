"use client";

import { useMemo } from "react";
import type { RunSource } from "@/lib/analytics/types";
import { useAlertsEnabled } from "@/lib/hooks/use-notifications";
import { useOrganization } from "@/lib/hooks/use-organization";

const WITHOUT_ALERTS: RunSource[] = ["workflow", "direct"];

/**
 * The sources to ask for: alert rows only where alerts are switched on. Null
 * until that is known, so callers hold their fetches instead of asking twice.
 */
export function useRunSources(picked: RunSource[]): RunSource[] | null {
  const { organization } = useOrganization();
  const alertsEnabled = useAlertsEnabled(organization?.id);
  return useMemo(() => {
    if (alertsEnabled === null) {
      return null;
    }
    if (alertsEnabled) {
      return picked;
    }
    const kept = picked.filter((source) => source !== "notification");
    return kept.length > 0 ? kept : WITHOUT_ALERTS;
  }, [alertsEnabled, picked]);
}
