import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CardFooter } from "@/components/ui/card";
import { SUPPORT_LABELS } from "@/lib/billing/constants";
import type { BillingInterval, PLANS, PlanName } from "@/lib/billing/plans";
import { cn } from "@/lib/utils";
import type { PlanTierItem } from "./types";
import { formatPrice, getButtonLabel, getExecutionsDisplay } from "./utils";

export function FeatureRow({
  label,
  value,
  highlight = false,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}): React.ReactElement {
  return (
    <div className="flex items-center justify-between py-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={cn(highlight && "text-keeperhub-green-dark font-medium")}
      >
        {value}
      </span>
    </div>
  );
}

export function PlanCardBadge({
  isActive,
  isPopular,
}: {
  isActive: boolean;
  isPopular: boolean;
}): React.ReactElement | null {
  if (isActive) {
    return (
      <div className="absolute top-6 right-3">
        <Badge className="bg-keeperhub-green-dark text-white border-0 text-xs px-3">
          ACTIVE
        </Badge>
      </div>
    );
  }
  if (!isPopular) {
    return null;
  }
  return (
    <div className="absolute -top-3 left-1/2 -translate-x-1/2">
      <Badge className="bg-keeperhub-green-dark text-white border-0 text-xs px-3">
        POPULAR
      </Badge>
    </div>
  );
}

export function PlanCardFeatures({
  plan,
  planName,
  activeTier,
  gasCreditCentsCap,
}: {
  plan: (typeof PLANS)[PlanName];
  planName: PlanName;
  activeTier: PlanTierItem | undefined;
  gasCreditCentsCap?: number;
}): React.ReactElement {
  const isEnterprise = planName === "enterprise";
  const executionsDisplay = getExecutionsDisplay(planName, activeTier);

  const capCents = gasCreditCentsCap ?? plan.features.gasCreditsCents;
  const gasCredits = isEnterprise
    ? `$${(capCents / 100).toFixed(0)}+/mo`
    : `$${(capCents / 100).toFixed(0)}/mo`;

  const logRetention =
    plan.features.logRetentionDays >= 365
      ? "1 year"
      : `${plan.features.logRetentionDays} days`;

  return (
    <div className="space-y-0.5 border-t border-border/50 pt-3">
      {executionsDisplay && (
        <FeatureRow
          highlight
          label="Executions"
          value={`${executionsDisplay}/mo`}
        />
      )}
      <FeatureRow highlight label="Gas credits" value={gasCredits} />

      <div className="border-t border-border/30 my-2" />

      <FeatureRow label="Workflows" value="Unlimited" />
      <FeatureRow
        label="Chains"
        value={isEnterprise ? "All + Custom" : "All"}
      />
      <FeatureRow
        label="Triggers"
        value={isEnterprise ? "All + Custom" : "All"}
      />
      <FeatureRow
        label="API"
        value={plan.features.apiAccess === "full" ? "Full" : "Rate-limited"}
      />
      <FeatureRow label="Logs" value={logRetention} />
      <FeatureRow
        label="Support"
        value={SUPPORT_LABELS[plan.features.supportLevel] ?? "Community"}
      />
      {plan.features.sla && (
        <FeatureRow label="SLA" value={plan.features.sla} />
      )}
    </div>
  );
}

export function PriceDisplay({
  price,
  annualTotal,
  interval,
}: {
  price: number | null;
  annualTotal: number | null;
  interval: BillingInterval;
}): React.ReactElement {
  if (price === null) {
    return (
      <div>
        <span className="text-3xl font-bold text-keeperhub-green-dark">
          {interval === "yearly" ? "$1,999+" : "$2,499+"}
        </span>
        <span className="text-muted-foreground text-sm">/mo</span>
      </div>
    );
  }
  return (
    <div>
      <span className="text-3xl font-bold text-keeperhub-green-dark">
        {formatPrice(price)}
      </span>
      <span className="text-muted-foreground text-sm">/mo</span>
      {annualTotal !== null && (
        <p className="text-muted-foreground text-xs mt-1">
          {formatPrice(annualTotal)}/year billed annually
        </p>
      )}
    </div>
  );
}

export function PlanCardFooter({
  planName,
  plan,
  isCurrent,
  loading,
  isPopular,
  currentPlan,
  hasSubscription,
  onSubscribe,
}: {
  planName: PlanName;
  plan: (typeof PLANS)[PlanName];
  isCurrent: boolean;
  loading: boolean;
  isPopular: boolean;
  currentPlan?: PlanName;
  hasSubscription: boolean;
  onSubscribe: () => void;
}): React.ReactElement {
  const isFree = planName === "free";
  const isEnterprise = planName === "enterprise";

  return (
    <CardFooter className="flex-col gap-3">
      <div className="w-full text-center">
        {isFree && (
          <span className="text-xs text-muted-foreground">No overage</span>
        )}
        {plan.overage.enabled && (
          <Badge className="text-xs" variant="outline">
            ${plan.overage.ratePerThousand}/1K additional executions
          </Badge>
        )}
        {isEnterprise && (
          <span className="text-xs text-muted-foreground">Custom pricing</span>
        )}
      </div>
      <Button
        className={cn(
          "w-full",
          isPopular &&
            "bg-keeperhub-green-dark hover:bg-keeperhub-green-dark/90 text-white"
        )}
        disabled={isCurrent || (isFree && currentPlan === "free") || loading}
        onClick={onSubscribe}
        variant={isPopular ? "default" : "outline"}
      >
        {getButtonLabel(planName, isCurrent, loading, hasSubscription)}
      </Button>
    </CardFooter>
  );
}
