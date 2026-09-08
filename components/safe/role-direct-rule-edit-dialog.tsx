"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { POLICY_PERIOD_OPTIONS } from "@/components/safe/policy-token-row";
import type {
  DirectRuleInput,
  PolicyConfig,
} from "@/components/safe/policy-wizard";
import type { RoleDirectRule } from "@/components/safe/role-direct-rule-row";
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

type Allowance = {
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

type Props = {
  rule: RoleDirectRule;
  safeId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** All current direct rules, used to rebuild the full `directRules` payload. */
  allDirectRules: RoleDirectRule[];
  /** Protocol rows from the role summary. */
  protocols: Protocol[];
  /** Allowance buckets from the role summary. */
  allowances: Allowance[];
  onUpdated: () => Promise<void>;
};

function counterpartyLabel(kind: string): string {
  if (kind === "erc20-approve") {
    return "Spender";
  }
  if (kind === "erc20-transfer") {
    return "Recipient";
  }
  return "Recipient";
}

function kindLabel(kind: string): string {
  if (kind === "erc20-transfer") {
    return "ERC-20 transfer";
  }
  if (kind === "erc20-approve") {
    return "ERC-20 approve";
  }
  return "Native send";
}

export function RoleDirectRuleEditDialog({
  rule,
  safeId,
  open,
  onOpenChange,
  allDirectRules,
  protocols,
  allowances,
  onUpdated,
}: Props): React.ReactElement {
  const [counterparty, setCounterparty] = useState<string>(rule.counterparty);
  const [amountHuman, setAmountHuman] = useState<string>(rule.amountHuman);
  const [periodSeconds, setPeriodSeconds] = useState<number>(
    rule.periodSeconds
  );
  const [submitting, setSubmitting] = useState<boolean>(false);

  useEffect(() => {
    if (open) {
      setCounterparty(rule.counterparty);
      setAmountHuman(rule.amountHuman);
      setPeriodSeconds(rule.periodSeconds);
    }
  }, [open, rule]);

  const isNative = rule.kind === "native-transfer";

  const buildPayload = (): PolicyConfig => {
    const protocolTokensBySlug: Record<
      string,
      Array<{
        tokenAddress: string;
        tokenSymbol: string;
        tokenDecimals: number;
        amountHuman: string;
        periodSeconds: number;
      }>
    > = {};
    for (const a of allowances) {
      if (a.protocolSlug === "direct") {
        continue;
      }
      if (!protocolTokensBySlug[a.protocolSlug]) {
        protocolTokensBySlug[a.protocolSlug] = [];
      }
      protocolTokensBySlug[a.protocolSlug].push({
        tokenAddress: a.tokenAddress,
        tokenSymbol: a.tokenSymbol,
        tokenDecimals: a.tokenDecimals,
        amountHuman: weiToHuman(a.maxRefillWei, a.tokenDecimals),
        periodSeconds: a.periodSeconds,
      });
    }

    const protocolsConfig = protocols
      .filter((p) => p.protocolSlug !== "direct" && p.status === "allowed")
      .map((p) => ({
        slug: p.protocolSlug,
        tokens: protocolTokensBySlug[p.protocolSlug] ?? [],
      }));

    const directRules: DirectRuleInput[] = allDirectRules.map((r) => {
      if (r.id === rule.id) {
        return {
          kind: r.kind as DirectRuleInput["kind"],
          tokenAddress: r.tokenAddress,
          tokenSymbol: r.tokenSymbol,
          tokenDecimals: r.tokenDecimals,
          counterparty,
          amountHuman,
          periodSeconds,
        };
      }
      return {
        kind: r.kind as DirectRuleInput["kind"],
        tokenAddress: r.tokenAddress,
        tokenSymbol: r.tokenSymbol,
        tokenDecimals: r.tokenDecimals,
        counterparty: r.counterparty,
        amountHuman: r.amountHuman,
        periodSeconds: r.periodSeconds,
      };
    });

    return { protocols: protocolsConfig, directRules };
  };

  const handleSave = async (): Promise<void> => {
    if (!counterparty.trim()) {
      toast.error("Recipient address is required");
      return;
    }
    if (!(isNative || amountHuman.trim())) {
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
      toast.success(data.noChanges ? "No changes to apply" : "Rule updated");
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
          <DialogTitle>Edit direct rule</DialogTitle>
          <DialogDescription>
            {kindLabel(rule.kind)} on {rule.tokenSymbol}. To change the kind or
            token, use Manage policies.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="direct-rule-counterparty">
              {counterpartyLabel(rule.kind)}
            </Label>
            <Input
              id="direct-rule-counterparty"
              onChange={(e) => setCounterparty(e.target.value)}
              placeholder="0x..."
              value={counterparty}
            />
          </div>

          {!isNative && (
            <div className="space-y-1">
              <Label htmlFor="direct-rule-amount">
                Cap ({rule.tokenSymbol})
              </Label>
              <Input
                id="direct-rule-amount"
                inputMode="decimal"
                onChange={(e) => setAmountHuman(e.target.value)}
                placeholder="1.0"
                value={amountHuman}
              />
            </div>
          )}

          <div className="space-y-1">
            <Label htmlFor="direct-rule-period">Refill period</Label>
            <Select
              onValueChange={(v) => setPeriodSeconds(Number(v))}
              value={periodSeconds.toString()}
            >
              <SelectTrigger id="direct-rule-period">
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
