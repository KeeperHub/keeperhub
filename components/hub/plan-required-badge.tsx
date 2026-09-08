import { Gem } from "lucide-react";
import type { PlanName } from "@/lib/billing/plans";

function formatPlanLabel(plan: PlanName): string {
  if (plan === "pro") {
    return "Pro";
  }
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}

type PlanRequiredBadgeProps = {
  plan: PlanName;
  className?: string;
};

export function PlanRequiredBadge({
  plan,
  className = "inline-flex h-[20px] shrink-0 items-center gap-1 rounded-full bg-[var(--color-bg-accent)] px-2",
}: PlanRequiredBadgeProps): React.ReactElement {
  const label = formatPlanLabel(plan);
  return (
    <span className={className} title={`Requires ${label} plan on free tier`}>
      <Gem className="size-2.5 text-[var(--color-text-accent)]" />
      <span className="text-[0.625rem] text-[var(--color-text-accent)]">
        {label}
      </span>
    </span>
  );
}
