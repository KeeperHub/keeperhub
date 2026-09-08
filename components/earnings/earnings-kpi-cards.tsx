"use client";

import { useAtomValue } from "jotai";
import { Activity, DollarSign, HelpCircle, TrendingUp } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { earningsDataAtom, earningsLoadingAtom } from "@/lib/atoms/earnings";
import { cn } from "@/lib/utils";

function SkeletonCard(): ReactNode {
  return (
    <Card>
      <CardContent className="pt-0">
        <div className="flex items-center justify-between">
          <div className="space-y-2">
            <div className="h-3 w-20 animate-pulse rounded bg-muted" />
            <div className="h-7 w-24 animate-pulse rounded bg-muted" />
          </div>
          <div className="size-10 animate-pulse rounded-lg bg-muted" />
        </div>
      </CardContent>
    </Card>
  );
}

type KpiCardProps = {
  icon: ReactNode;
  label: string;
  value: string;
  subtext?: string;
  helpHref?: string;
  helpTitle?: string;
  iconClassName?: string;
};

function KpiCard({
  icon,
  label,
  value,
  subtext,
  helpHref,
  helpTitle,
  iconClassName,
}: KpiCardProps): ReactNode {
  return (
    <Card>
      <CardContent className="pt-0">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-1.5">
              <p className="text-sm text-muted-foreground">{label}</p>
              {helpHref ? (
                <Link
                  aria-label={helpTitle ?? `Learn more about ${label}`}
                  className="text-muted-foreground/70 hover:text-foreground"
                  href={helpHref}
                  rel="noopener"
                  target="_blank"
                  title={helpTitle}
                >
                  <HelpCircle className="size-3.5" />
                </Link>
              ) : null}
            </div>
            <p className="text-2xl font-semibold tracking-tight">{value}</p>
            {subtext ? (
              <p className="text-xs text-muted-foreground">{subtext}</p>
            ) : null}
          </div>
          <div
            className={cn(
              "flex size-10 items-center justify-center rounded-lg",
              iconClassName ?? "bg-primary/10 text-primary"
            )}
          >
            {icon}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function EarningsKpiCards(): ReactNode {
  const data = useAtomValue(earningsDataAtom);
  const loading = useAtomValue(earningsLoadingAtom);

  if (loading && !data) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
      </div>
    );
  }

  if (!data) {
    return null;
  }

  const {
    totalGrossRevenue,
    totalCreatorEarnings,
    totalInvocations,
    creatorSharePercent,
    perChain,
  } = data;

  // Revenue arrives on Base (x402/USDC) or Tempo (MPP/USDC.e) depending on
  // which protocol the calling agent used. Showing the split inline prevents
  // creators from treating a zero on one chain as a bug.
  const revenueChainSplit = `Base ${perChain.base.grossRevenue} · Tempo ${perChain.tempo.grossRevenue}`;
  const invocationChainSplit = `Base ${perChain.base.invocationCount.toLocaleString()} · Tempo ${perChain.tempo.invocationCount.toLocaleString()}`;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <KpiCard
          helpHref="https://docs.keeperhub.com/workflows/marketplace#receiving-revenue-on-two-chains"
          helpTitle="How dual-chain revenue works"
          icon={<DollarSign className="size-5" />}
          iconClassName="bg-green-500/10 text-green-600 dark:text-green-400"
          label="Total Revenue"
          subtext={revenueChainSplit}
          value={totalGrossRevenue}
        />
        <KpiCard
          helpHref="https://docs.keeperhub.com/workflows/marketplace#earnings"
          helpTitle="How creator earnings are calculated"
          icon={<TrendingUp className="size-5" />}
          iconClassName="bg-keeperhub-green/10 text-keeperhub-green-dark"
          label="Earnings"
          subtext={`(${creatorSharePercent}% of gross revenue)`}
          value={totalCreatorEarnings}
        />
        <KpiCard
          icon={<Activity className="size-5" />}
          iconClassName="bg-blue-500/10 text-blue-600 dark:text-blue-400"
          label="Total Invocations"
          subtext={invocationChainSplit}
          value={totalInvocations.toLocaleString()}
        />
      </div>
    </div>
  );
}
