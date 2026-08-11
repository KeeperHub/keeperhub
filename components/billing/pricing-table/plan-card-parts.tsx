"use client";

import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CardFooter } from "@/components/ui/card";
import type { BillingInterval, PLANS, PlanName } from "@/lib/billing/plans";
import { cn } from "@/lib/utils";
import type { PlanTierItem } from "./types";
import { formatPrice, getButtonLabel, getTierPrice } from "./utils";

export function PlanCardBadge({
  isActive,
}: {
  isActive: boolean;
}): React.ReactElement | null {
  if (!isActive) {
    return null;
  }
  return (
    <div className="absolute top-4 right-4">
      <Badge className="border-0 bg-keeperhub-green-dark text-white text-xs px-2.5">
        CURRENT
      </Badge>
    </div>
  );
}

export function PlanHeader({
  name,
  price,
  isEnterprise,
  isFree = false,
  freePrice,
}: {
  name: string;
  price: number | null;
  isEnterprise: boolean;
  isFree?: boolean;
  freePrice?: string;
}): React.ReactElement {
  let priceNode: React.ReactElement;
  if (isEnterprise || price === null) {
    priceNode = (
      <span className="font-bold text-5xl text-keeperhub-green-dark">
        Custom
      </span>
    );
  } else if (isFree) {
    priceNode = (
      <span className="font-bold text-5xl text-keeperhub-green-dark">
        {freePrice ?? "$0.01"}
      </span>
    );
  } else {
    priceNode = (
      <>
        <span className="font-bold text-5xl text-keeperhub-green-dark">
          {formatPrice(price)}
        </span>
        <span className="text-muted-foreground text-xl ml-1">/mo</span>
      </>
    );
  }
  return (
    <div className="text-center">
      <h3 className="mb-3 font-bold text-2xl tracking-tight">{name}</h3>
      <div>{priceNode}</div>
    </div>
  );
}

export function HeroMetrics({
  executions,
  gas,
}: {
  executions: string;
  gas: string | null;
}): React.ReactElement {
  const gridCols = gas === null ? "grid-cols-1" : "grid-cols-2";
  return (
    <div className="mt-3 mb-3">
      <p className="mb-2 font-medium text-muted-foreground text-xs">
        Includes per month
      </p>
      <div
        className={`grid ${gridCols} gap-2 rounded-xl border border-border/60 bg-background/60 px-5 py-4`}
      >
        <div className="text-center">
          <p className="mb-1.5 whitespace-nowrap text-muted-foreground text-xs">
            Executions
          </p>
          <p className="font-bold text-2xl leading-tight">{executions}</p>
        </div>
        {gas !== null && (
          <div className="text-center">
            <p className="mb-1.5 whitespace-nowrap text-muted-foreground text-xs">
              Gas credits
            </p>
            <p className="font-bold text-2xl leading-tight">{gas}</p>
          </div>
        )}
      </div>
    </div>
  );
}

export function TierSelect({
  options,
  value,
  onChange,
  interval,
}: {
  options: PlanTierItem[];
  value: string;
  onChange: (key: string) => void;
  interval: BillingInterval;
}): React.ReactElement {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    function handleClickOutside(event: MouseEvent): void {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return (): void =>
      document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  const selected = options.find((opt) => opt.key === value) ?? options[0];

  return (
    <div className="relative mb-4" ref={containerRef}>
      <button
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        className="flex w-full cursor-pointer items-center justify-between rounded-lg border border-border/60 bg-background/60 px-4 py-2.5 text-sm transition-colors hover:border-keeperhub-green-dark/60"
        onClick={() => setIsOpen((prev) => !prev)}
        type="button"
      >
        <span className="font-medium">
          {selected.executions.toLocaleString()} executions
        </span>
        <ChevronDown
          className={cn(
            "size-4 text-muted-foreground transition-transform duration-200",
            isOpen && "rotate-180"
          )}
        />
      </button>

      {isOpen && (
        <div
          className="absolute top-full right-0 left-0 z-20 mt-1 overflow-hidden rounded-lg border border-border/60 bg-popover shadow-xl shadow-black/10"
          role="listbox"
        >
          {options.map((opt) => {
            const isSelected = opt.key === value;
            return (
              <button
                aria-selected={isSelected}
                className={cn(
                  "flex w-full cursor-pointer items-center justify-between px-4 py-2.5 text-sm transition-colors",
                  isSelected
                    ? "bg-keeperhub-green-dark/10 text-keeperhub-green-dark"
                    : "text-foreground hover:bg-muted"
                )}
                key={opt.key}
                onClick={() => {
                  onChange(opt.key);
                  setIsOpen(false);
                }}
                role="option"
                type="button"
              >
                <span className={isSelected ? "font-medium" : ""}>
                  {opt.executions.toLocaleString()} executions
                </span>
                <span
                  className={
                    isSelected
                      ? "text-keeperhub-green-dark"
                      : "text-muted-foreground"
                  }
                >
                  {formatPrice(getTierPrice(opt, interval))}/mo
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function PlanCardFooter({
  planName,
  plan,
  isCurrent,
  loading,
  currentPlan,
  hasSubscription,
  onSubscribe,
}: {
  planName: PlanName;
  plan: (typeof PLANS)[PlanName];
  isCurrent: boolean;
  loading: boolean;
  currentPlan?: PlanName;
  hasSubscription: boolean;
  onSubscribe: () => void;
}): React.ReactElement {
  const isFree = planName === "free";
  const isEnterprise = planName === "enterprise";

  let overageLabel: string | null = null;
  if (plan.overage.enabled) {
    overageLabel = `$${plan.overage.ratePerThousand}/1K additional executions`;
  } else if (isFree) {
    overageLabel = `${plan.features.maxExecutionsPerMonth.toLocaleString()} free / mo, then pay-as-you-go`;
  } else if (isEnterprise) {
    overageLabel = "Custom overage terms";
  }

  return (
    <CardFooter className="mt-auto flex-col gap-3">
      <Button
        className="w-full rounded-full"
        disabled={isCurrent || (isFree && currentPlan === "free") || loading}
        onClick={onSubscribe}
        variant="outline"
      >
        {getButtonLabel(planName, isCurrent, loading, hasSubscription)}
      </Button>
      {overageLabel && (
        <span className="rounded-full border border-border/50 bg-muted/40 px-3 py-1 text-center text-muted-foreground text-xs">
          {overageLabel}
        </span>
      )}
    </CardFooter>
  );
}
