"use client";

import { ChevronRightIcon, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";

/**
 * Compact summary card for the wallet overlay's Manage tab. Shows the
 * count of deployed Safes and acts as the click target that swaps the
 * overlay's content area into the dedicated Safe view (`<DeploySafeCard>`
 * lives over there). Keeps the Manage tab from growing linearly with
 * chains.
 */

type SafeRow = {
  id: string;
  status: string;
};

type SafeListResponse = {
  safes?: SafeRow[];
};

type SafeWalletsEntryCardProps = {
  isAdmin: boolean;
  onOpen: () => void;
};

export function SafeWalletsEntryCard({
  isAdmin,
  onOpen,
}: SafeWalletsEntryCardProps): React.ReactElement | null {
  const [count, setCount] = useState<number | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const res = await fetch("/api/user/safe");
        if (!res.ok) {
          if (!cancelled) {
            setCount(0);
          }
          return;
        }
        const data = (await res.json()) as SafeListResponse;
        if (cancelled) {
          return;
        }
        const deployed = (data.safes ?? []).filter(
          (s) => s.status === "deployed"
        ).length;
        setCount(deployed);
      } catch {
        if (!cancelled) {
          setCount(0);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };
    load();
    return (): void => {
      cancelled = true;
    };
  }, []);

  if (!isAdmin && count === 0) {
    return null;
  }

  const summary = ((): string => {
    if (loading) {
      return "Loading...";
    }
    if (count === null || count === 0) {
      return "No Safe wallets deployed yet.";
    }
    return `${count} Safe wallet${count === 1 ? "" : "s"} deployed.`;
  })();

  return (
    <button
      aria-label="Open Safe wallets manager"
      className="group flex w-full items-center gap-3 rounded-lg border bg-card p-4 text-left transition-colors hover:border-primary/40"
      onClick={onOpen}
      type="button"
    >
      <div className="rounded-md border bg-muted/30 p-2 text-muted-foreground">
        <ShieldCheck className="h-4 w-4" />
      </div>
      <div className="flex-1 space-y-0.5">
        <div className="font-medium text-sm">Safe wallets</div>
        <div className="text-muted-foreground text-xs">{summary}</div>
      </div>
      <ChevronRightIcon
        aria-hidden="true"
        className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5"
      />
    </button>
  );
}
