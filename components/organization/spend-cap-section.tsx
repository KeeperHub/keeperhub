"use client";

import { ethers } from "ethers";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type SpendCapResponse = {
  dailyCapWei: string | null;
  dailyUsedWei: string;
  dailySolanaCapLamports: string | null;
  dailySolanaUsedLamports: string;
};

// Native decimals per chain family. The two caps are stored in their own base
// units (wei / lamports) and are never converted into one another: they bound
// different assets, so a single shared figure would be meaningless.
const EVM_DECIMALS = 18;
const SOLANA_DECIMALS = 9;

function formatBase(base: string, decimals: number): string {
  try {
    return ethers.formatUnits(base, decimals);
  } catch {
    return "0";
  }
}

function parseToBase(input: string, decimals: number): string | null {
  const trimmed = input.trim();
  if (trimmed === "") {
    return null;
  }
  try {
    const parsed = ethers.parseUnits(trimmed, decimals);
    // parseUnits("-5") yields a negative BigInt without throwing; the cap must
    // be non-negative (the server also rejects it).
    return parsed < BigInt(0) ? null : parsed.toString();
  } catch {
    return null;
  }
}

type CapControlProps = {
  id: string;
  label: string;
  symbol: string;
  decimals: number;
  cap: string | null;
  used: string;
  disabled: boolean;
  saving: boolean;
  onSave: (base: string | null) => void;
};

function CapControl({
  id,
  label,
  symbol,
  decimals,
  cap,
  used,
  disabled,
  saving,
  onSave,
}: CapControlProps): React.ReactElement {
  const [input, setInput] = useState("");

  // Re-sync the field whenever the persisted cap changes (initial load, save,
  // or clear), so the input always reflects what is actually stored.
  useEffect(() => {
    setInput(cap ? formatBase(cap, decimals) : "");
  }, [cap, decimals]);

  const handleSave = useCallback(() => {
    // An empty field clears the org's own cap, which hands the chain family
    // back to the platform default.
    if (input.trim() === "") {
      onSave(null);
      return;
    }
    const base = parseToBase(input, decimals);
    if (base === null) {
      toast.error(
        `Enter a valid ${symbol} amount (up to ${decimals} decimals)`
      );
      return;
    }
    onSave(base);
  }, [input, decimals, symbol, onSave]);

  const usedDisplay = formatBase(used, decimals);

  return (
    <div className="space-y-2">
      <Label className="text-sm" htmlFor={id}>
        {label}
      </Label>
      <Input
        disabled={disabled}
        id={id}
        inputMode="decimal"
        onChange={(e) => setInput(e.target.value)}
        placeholder="e.g. 1.5"
        value={input}
      />
      <p className="text-muted-foreground text-xs">
        {cap
          ? `Current cap: ${formatBase(cap, decimals)} ${symbol}/day - used ${usedDisplay} ${symbol} today`
          : `No cap set - the platform default applies - used ${usedDisplay} ${symbol} today`}
      </p>
      <div className="flex gap-2">
        <Button
          className="flex-1"
          disabled={disabled}
          onClick={handleSave}
          size="sm"
          variant="outline"
        >
          {saving ? "Saving..." : "Save cap"}
        </Button>
        <Button
          disabled={disabled || !cap}
          onClick={() => onSave(null)}
          size="sm"
          variant="ghost"
        >
          Clear
        </Button>
      </div>
    </div>
  );
}

/**
 * Organization daily value-cap controls. Reads and writes the active org's
 * `daily_value_cap_wei` and `daily_solana_value_cap_lamports` via
 * /api/analytics/spend-cap; the PUT is gated server side by
 * `organization:update` (owner/admin) over the session, so this only mounts
 * inside an admin-gated surface.
 *
 * The two caps are independent and saved independently - each control sends
 * only its own field, and the route leaves an omitted field untouched, so
 * saving one cap cannot clear the other.
 */
export function SpendCapSection(): React.ReactElement {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [capWei, setCapWei] = useState<string | null>(null);
  const [usedWei, setUsedWei] = useState("0");
  const [capLamports, setCapLamports] = useState<string | null>(null);
  const [usedLamports, setUsedLamports] = useState("0");

  const load = useCallback(() => {
    setLoading(true);
    fetch("/api/analytics/spend-cap")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: SpendCapResponse | null) => {
        if (!data) {
          return;
        }
        setCapWei(data.dailyCapWei);
        setUsedWei(data.dailyUsedWei);
        setCapLamports(data.dailySolanaCapLamports);
        setUsedLamports(data.dailySolanaUsedLamports);
      })
      .catch(() => {
        toast.error("Could not load the spend cap");
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const save = useCallback(
    async (
      field: "dailyValueCapWei" | "dailySolanaValueCapLamports",
      base: string | null
    ) => {
      setSaving(true);
      try {
        const res = await fetch("/api/analytics/spend-cap", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          // Only this control's field is sent; the other cap is left untouched.
          body: JSON.stringify({ [field]: base }),
        });
        if (res.ok) {
          if (field === "dailyValueCapWei") {
            setCapWei(base);
          } else {
            setCapLamports(base);
          }
          toast.success(
            base
              ? "Daily value cap saved"
              : "Daily value cap reset to the platform default"
          );
        } else if (res.status === 403) {
          toast.error("Only organization owners and admins can change the cap");
        } else {
          toast.error("Could not save the cap");
        }
      } catch {
        toast.error("Could not save the cap");
      } finally {
        setSaving(false);
      }
    },
    []
  );

  const saveEvm = useCallback(
    (base: string | null) => save("dailyValueCapWei", base),
    [save]
  );
  const saveSolana = useCallback(
    (base: string | null) => save("dailySolanaValueCapLamports", base),
    [save]
  );

  return (
    <div className="space-y-3">
      <h4 className="font-medium text-muted-foreground text-sm">
        Daily value caps
      </h4>
      <p className="text-muted-foreground text-xs">
        Limits the total native value that direct execution API calls and
        workflow runs can move per day for this organization. EVM and Solana are
        capped separately, in their own currencies. Leave a field empty to fall
        back to the platform default; there is no uncapped setting.
      </p>

      <CapControl
        cap={capWei}
        decimals={EVM_DECIMALS}
        disabled={loading || saving}
        id="daily-value-cap"
        label="EVM cap (ETH per day)"
        onSave={saveEvm}
        saving={saving}
        symbol="ETH"
        used={usedWei}
      />

      <CapControl
        cap={capLamports}
        decimals={SOLANA_DECIMALS}
        disabled={loading || saving}
        id="daily-solana-value-cap"
        label="Solana cap (SOL per day)"
        onSave={saveSolana}
        saving={saving}
        symbol="SOL"
        used={usedLamports}
      />
    </div>
  );
}
