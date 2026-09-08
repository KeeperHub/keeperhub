"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { POLICY_PERIOD_OPTIONS } from "@/components/safe/policy-token-row";
import type {
  DirectRuleInput,
  PolicyConfig,
} from "@/components/safe/policy-wizard";
import { weiToHuman } from "@/components/safe/wei-to-human";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getProtocolLabel } from "@/lib/safe/protocol-registry";

type Allowance = {
  id: string;
  protocolSlug: string;
  tokenAddress: string;
  tokenSymbol: string;
  tokenDecimals: number;
  maxRefillWei: string;
  periodSeconds: number;
};

type Protocol = {
  protocolSlug: string;
  status: string;
};

type DirectRule = {
  kind: string;
  tokenAddress: string | null;
  tokenSymbol: string;
  tokenDecimals: number;
  counterparty: string;
  amountHuman: string;
  periodSeconds: number;
};

type Props = {
  /** The allowance row being edited. */
  allowance: Allowance;
  safeId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** All current allowances for this role; used to rebuild the full payload
   *  and substitute the edited bucket. */
  allAllowances: Allowance[];
  /** Protocol rows (so we know which slugs are still active). */
  protocols: Protocol[];
  /** Direct rules round-tripped untouched in the payload. */
  directRules: DirectRule[];
  onUpdated: () => Promise<void>;
};

export function RoleAllowanceEditDialog({
  allowance,
  safeId,
  open,
  onOpenChange,
  allAllowances,
  protocols,
  directRules,
  onUpdated,
}: Props): React.ReactElement {
  const [amountHuman, setAmountHuman] = useState<string>(
    weiToHuman(allowance.maxRefillWei, allowance.tokenDecimals)
  );
  const [periodSeconds, setPeriodSeconds] = useState<number>(
    allowance.periodSeconds
  );
  const [submitting, setSubmitting] = useState<boolean>(false);

  useEffect(() => {
    if (open) {
      setAmountHuman(
        weiToHuman(allowance.maxRefillWei, allowance.tokenDecimals)
      );
      setPeriodSeconds(allowance.periodSeconds);
    }
  }, [open, allowance]);

  const buildPayload = (): PolicyConfig => {
    const tokensBySlug: Record<
      string,
      Array<{
        tokenAddress: string;
        tokenSymbol: string;
        tokenDecimals: number;
        amountHuman: string;
        periodSeconds: number;
      }>
    > = {};

    for (const a of allAllowances) {
      if (a.protocolSlug === "direct") {
        continue;
      }
      const isTarget = a.id === allowance.id;
      if (!tokensBySlug[a.protocolSlug]) {
        tokensBySlug[a.protocolSlug] = [];
      }
      tokensBySlug[a.protocolSlug].push({
        tokenAddress: a.tokenAddress,
        tokenSymbol: a.tokenSymbol,
        tokenDecimals: a.tokenDecimals,
        amountHuman: isTarget
          ? amountHuman
          : weiToHuman(a.maxRefillWei, a.tokenDecimals),
        periodSeconds: isTarget ? periodSeconds : a.periodSeconds,
      });
    }

    const protocolsConfig = protocols
      .filter((p) => p.protocolSlug !== "direct" && p.status === "allowed")
      .map((p) => ({
        slug: p.protocolSlug,
        tokens: tokensBySlug[p.protocolSlug] ?? [],
      }));

    const directRulesConfig: DirectRuleInput[] = directRules.map((r) => ({
      kind: r.kind as DirectRuleInput["kind"],
      tokenAddress: r.tokenAddress,
      tokenSymbol: r.tokenSymbol,
      tokenDecimals: r.tokenDecimals,
      counterparty: r.counterparty,
      amountHuman: r.amountHuman,
      periodSeconds: r.periodSeconds,
    }));

    return { protocols: protocolsConfig, directRules: directRulesConfig };
  };

  const handleSave = async (): Promise<void> => {
    if (!amountHuman.trim()) {
      toast.error("Cap amount is required");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`/api/user/safe/${safeId}/role/update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload()),
      });
      const data = (await res.json()) as {
        success?: boolean;
        error?: string;
        noChanges?: boolean;
      };
      if (!(res.ok && data.success)) {
        toast.error(data.error ?? "Update failed");
        return;
      }
      toast.success(
        data.noChanges ? "No changes to apply" : "Allowance updated"
      );
      onOpenChange(false);
      await onUpdated();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Update failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Edit allowance</DialogTitle>
          <DialogDescription>
            {getProtocolLabel(allowance.protocolSlug)} · {allowance.tokenSymbol}
            . Change the cap or refill period for this bucket.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="allowance-amount">
              Cap ({allowance.tokenSymbol})
            </Label>
            <Input
              id="allowance-amount"
              inputMode="decimal"
              onChange={(e) => setAmountHuman(e.target.value)}
              placeholder="1.0"
              value={amountHuman}
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="allowance-period">Refill period</Label>
            <Select
              onValueChange={(v) => setPeriodSeconds(Number(v))}
              value={periodSeconds.toString()}
            >
              <SelectTrigger id="allowance-period">
                <SelectValue placeholder="Select a period" />
              </SelectTrigger>
              <SelectContent>
                {POLICY_PERIOD_OPTIONS.map((o) => (
                  <SelectItem key={o.seconds} value={o.seconds.toString()}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button
            disabled={submitting}
            onClick={() => onOpenChange(false)}
            type="button"
            variant="outline"
          >
            Cancel
          </Button>
          <Button
            disabled={submitting}
            onClick={() => {
              handleSave().catch(() => {
                // toast already fired
              });
            }}
            type="button"
          >
            {submitting ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
