"use client";

import { ChevronRight, Info } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { BILLING_API } from "@/lib/billing/constants";
import { cn } from "@/lib/utils";
import {
  SPONSORSHIP_MAINNET_NAMES,
  SPONSORSHIP_TESTNET_NAMES,
} from "@/lib/web3/sponsorship-chains-meta";

type ChainSponsorship = {
  chainId: number;
  name: string;
  isTestnet: boolean;
  sponsoredWei: string;
  sponsoredMicroUsd: string;
  txCount: number;
};

type MonthlySponsorship = {
  monthStart: string;
  totalMicroUsd: string;
  byChain: ChainSponsorship[];
};

type HistoryResponse = { months: MonthlySponsorship[] };

// Sponsored amounts are routinely sub-cent (an L2 approve is fractions of a
// cent). Rounding to whole cents would show "$0.00" while the spend genuinely
// accrues against the cap, so render the exact value: up to micro-dollar
// precision (6 decimals), trailing zeros trimmed, never fewer than 2 decimals.
function formatMicroUsd(microUsd: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(Number(microUsd) / 1_000_000);
}

function formatNativeGas(wei: string): string {
  const value = Number(wei) / 1e18;
  if (value === 0) {
    return "0";
  }
  return value.toFixed(6);
}

function formatMonth(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
}

/**
 * Single sponsorship panel: the always-visible header lists the sponsored
 * networks; expanding reveals the monthly, per-network history (retained past
 * month-end) with a testnets toggle.
 */
export function GasSponsorshipHistory(): React.ReactElement {
  const [months, setMonths] = useState<MonthlySponsorship[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [includeTestnets, setIncludeTestnets] = useState(false);

  const fetchHistory = useCallback(async (testnets: boolean): Promise<void> => {
    const params = new URLSearchParams();
    if (testnets) {
      params.set("includeTestnets", "true");
    }
    const query = params.toString();
    const response = await fetch(
      `${BILLING_API.GAS_SPONSORSHIP}${query ? `?${query}` : ""}`
    );
    if (!response.ok) {
      return;
    }
    const data = (await response.json()) as HistoryResponse;
    setMonths(data.months);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      try {
        await fetchHistory(includeTestnets);
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }
    load().catch(() => {
      if (!cancelled) {
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [fetchHistory, includeTestnets]);

  return (
    <Collapsible
      className="rounded-md border border-border/60 bg-muted/30"
      onOpenChange={setOpen}
      open={open}
    >
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <div className="flex items-center gap-1.5">
          <CollapsibleTrigger asChild>
            <button
              className="flex items-center gap-1.5 text-foreground text-xs font-medium transition-colors hover:text-foreground"
              type="button"
            >
              <ChevronRight
                className={cn(
                  "size-4 shrink-0 text-muted-foreground transition-transform",
                  open && "rotate-90"
                )}
              />
              Sponsored networks
            </button>
          </CollapsibleTrigger>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                aria-label="Learn more about sponsored networks"
                className="inline-flex items-center text-muted-foreground/70 transition-colors hover:text-foreground"
                type="button"
              >
                <Info className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs space-y-2 px-3 py-2 text-left">
              <p className="font-medium">Sponsored via Turnkey Gas Station</p>
              <div className="space-y-1">
                <p className="text-[10px] uppercase tracking-wide opacity-70">
                  Testnets
                </p>
                <p>{SPONSORSHIP_TESTNET_NAMES.join(", ")}</p>
              </div>
              <p className="opacity-70">
                Transactions on other chains fall back to your wallet's native
                balance for gas.
              </p>
            </TooltipContent>
          </Tooltip>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {SPONSORSHIP_MAINNET_NAMES.map((name) => (
            <Badge className="text-[10px]" key={name} variant="secondary">
              {name}
            </Badge>
          ))}
        </div>
      </div>
      <CollapsibleContent>
        <div className="space-y-4 border-border/60 border-t px-3 pt-3 pb-3">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
              Monthly history
            </span>
            <div className="flex items-center gap-2">
              <Switch
                checked={includeTestnets}
                id="show-testnets"
                onCheckedChange={setIncludeTestnets}
              />
              <Label
                className="text-muted-foreground text-xs"
                htmlFor="show-testnets"
              >
                Show testnets
              </Label>
            </div>
          </div>
          {(() => {
            if (loading) {
              return (
                <p className="text-muted-foreground text-sm">Loading...</p>
              );
            }
            if (months.length === 0) {
              return (
                <p className="text-muted-foreground text-sm">
                  No gas has been sponsored yet.
                </p>
              );
            }
            return months.map((month) => (
              <div className="space-y-2" key={month.monthStart}>
                <div className="flex items-baseline justify-between">
                  <h4 className="font-medium text-sm">
                    {formatMonth(month.monthStart)}
                  </h4>
                  <span className="font-medium text-sm">
                    {formatMicroUsd(month.totalMicroUsd)}
                  </span>
                </div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Network</TableHead>
                      <TableHead className="text-right">Transactions</TableHead>
                      <TableHead className="text-right">Gas (native)</TableHead>
                      <TableHead className="text-right">USD</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {month.byChain.map((chain) => (
                      <TableRow key={`${month.monthStart}-${chain.chainId}`}>
                        <TableCell className="whitespace-nowrap">
                          {chain.name}
                          {chain.isTestnet ? (
                            <span className="ml-2 text-muted-foreground text-xs">
                              testnet
                            </span>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-right">
                          {chain.txCount.toLocaleString()}
                        </TableCell>
                        <TableCell className="text-right">
                          {formatNativeGas(chain.sponsoredWei)}
                        </TableCell>
                        <TableCell className="text-right">
                          {chain.isTestnet
                            ? "--"
                            : formatMicroUsd(chain.sponsoredMicroUsd)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ));
          })()}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
