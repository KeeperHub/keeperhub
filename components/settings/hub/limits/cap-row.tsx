"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatCapAmount as fromBase } from "@/lib/wallet/spend-cap";
import type { SpendCap } from "../hooks/use-spend-caps";

function toBase(input: string, decimals: number): string | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }
  const [whole = "0", frac = ""] = trimmed.split(".");
  const padded = frac.padEnd(decimals, "0").slice(0, decimals);
  return (
    BigInt(whole) * BigInt(10) ** BigInt(decimals) +
    BigInt(padded || "0")
  ).toString();
}

export function CapRow({
  cap,
  disabled,
  onSave,
}: {
  cap: SpendCap;
  disabled: boolean;
  onSave: (base: string | null) => Promise<void>;
}): React.ReactElement {
  const [input, setInput] = useState("");

  useEffect(() => {
    setInput(cap.cap ? fromBase(cap.cap, cap.decimals) : "");
  }, [cap.cap, cap.decimals]);

  const used = fromBase(cap.used, cap.decimals);
  // The platform default governs an org that set no cap of its own, so it is
  // the denominator here too. Showing "no cap" for that state made a request
  // the default refused look like the dashboard had not reached the API.
  const limit = cap.cap ?? cap.effectiveCap;
  const limitDisplay = limit ? fromBase(limit, cap.decimals) : null;
  const limitNumber = limitDisplay ? Number(limitDisplay) : 0;
  const pct =
    limitNumber > 0 ? Math.min(100, (Number(used) / limitNumber) * 100) : 0;

  return (
    <div className="flex flex-col gap-3 rounded-lg border p-4">
      <div className="flex items-baseline justify-between gap-4">
        <span className="font-medium text-sm">{cap.label}</span>
        <span className="font-mono text-muted-foreground text-xs">
          {used} / {limitDisplay ?? "-"} {cap.symbol} today
        </span>
      </div>

      {cap.usingDefault && limitDisplay && (
        <p className="text-muted-foreground text-xs">
          No cap of your own is set, so the platform default of {limitDisplay}{" "}
          {cap.symbol} per day applies. There is no uncapped setting.
        </p>
      )}

      {limitDisplay && (
        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-foreground/70"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}

      <div className="flex items-center gap-2">
        <Input
          className="h-9 max-w-40"
          disabled={disabled}
          id={`cap-${cap.id}`}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Platform default"
          value={input}
        />
        <span className="text-muted-foreground text-xs">
          {cap.symbol} per day
        </span>
        <div className="ml-auto flex gap-2">
          <Button
            disabled={disabled}
            onClick={() => onSave(toBase(input, cap.decimals))}
            size="sm"
          >
            Save
          </Button>
          {cap.cap && (
            <Button
              disabled={disabled}
              onClick={() => onSave(null)}
              size="sm"
              variant="ghost"
            >
              Clear
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
