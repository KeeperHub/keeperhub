"use client";

import { useState } from "react";
import { PricingTable } from "@/components/billing/pricing-table";
import type { BillingInterval } from "@/lib/billing/plans";
import { useBillingPlan } from "./hooks/use-billing-plan";
import { OWNER_ONLY_LINE, PLANS_DESCRIPTION } from "./plans-description";
import { SectionHeader } from "./section";
import { useSettingsContext } from "./settings-context";

export function PlansSection(): React.ReactElement {
  const billing = useBillingPlan();
  const { isOwner, role } = useSettingsContext();
  // Held here, not in the table: the table remounts when the plan loads, and
  // a choice made before that should survive it.
  const [interval, setBillingInterval] = useState<BillingInterval>("monthly");

  return (
    <>
      <SectionHeader
        // Only a role that is known and is not the owner's gets the owner-only
        // line, so an owner never sees it, even while the role loads or when
        // it cannot be loaded.
        description={
          role && role !== "owner"
            ? `${PLANS_DESCRIPTION} ${OWNER_ONLY_LINE}`
            : PLANS_DESCRIPTION
        }
        title="Plans"
      />

      {/* The grid is the same size whichever plan is current, and the table
          comes from a package with no loading state of its own, so it renders
          straight away and only the highlighted plan arrives late. */}
      <PricingTable
        canManage={isOwner}
        currentInterval={billing.interval}
        currentPlan={billing.plan}
        currentTier={billing.tier}
        gasCreditCaps={billing.gasCreditCaps}
        interval={interval}
        // The trial tier decides the Pro card's default selection, which is
        // state inside the table, so a change has to remount it.
        key={`${billing.plan}-${billing.tier ?? "none"}-${billing.interval ?? "none"}-${billing.refreshKey}`}
        onIntervalChange={setBillingInterval}
        onPlanUpdated={billing.refresh}
        trial={billing.trial}
      />
    </>
  );
}
