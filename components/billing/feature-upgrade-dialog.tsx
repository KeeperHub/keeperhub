"use client";

import { Gem } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { FeatureDefinition } from "@/lib/features";

type FeatureUpgradeDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  feature: FeatureDefinition | null;
};

const PLAN_LABELS: Record<string, string> = {
  pro: "Pro",
  business: "Business",
  enterprise: "Enterprise",
};

const PRICING_URL = "https://keeperhub.com/pricing";

export function FeatureUpgradeDialog({
  open,
  onOpenChange,
  feature,
}: FeatureUpgradeDialogProps): React.ReactElement | null {
  if (!feature) {
    return null;
  }

  const planLabel = PLAN_LABELS[feature.requiredPlan] ?? feature.requiredPlan;
  const headline = `${feature.name} requires ${planLabel}`;
  const description = feature.upgradeCta ?? feature.description;

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <div className="flex items-center gap-2">
            <Gem className="size-5 text-[var(--color-text-accent)]" />
            <DialogTitle>{headline}</DialogTitle>
          </div>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} variant="ghost">
            Not now
          </Button>
          <Button asChild>
            <a
              href={PRICING_URL}
              onClick={() => onOpenChange(false)}
              rel="noopener noreferrer"
              target="_blank"
            >
              Upgrade to {planLabel}
            </a>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
