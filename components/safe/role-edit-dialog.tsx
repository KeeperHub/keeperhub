"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
  type DirectRuleInput,
  type PolicyConfig,
  PolicyWizard,
  type SimulationPlan,
} from "@/components/safe/policy-wizard";
import { weiToHuman } from "@/components/safe/wei-to-human";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export type EditableRoleSummary = {
  protocols: Array<{
    protocolSlug: string;
    status: string;
  }>;
  allowances: Array<{
    protocolSlug: string;
    tokenAddress: string;
    tokenSymbol: string;
    tokenDecimals: number;
    maxRefillWei: string;
    periodSeconds: number;
  }>;
  directRules?: Array<{
    kind: string;
    tokenAddress: string | null;
    tokenSymbol: string;
    tokenDecimals: number;
    counterparty: string;
    amountHuman: string;
    periodSeconds: number;
  }>;
};

type Props = {
  safeId: string;
  chainId: number;
  safeAddress?: string;
  role: EditableRoleSummary;
  editing: boolean;
  setEditing: (value: boolean) => void;
  onUpdated: () => Promise<void>;
};

export function RoleEditDialog({
  safeId,
  chainId,
  safeAddress,
  role,
  editing,
  setEditing,
  onUpdated,
}: Props): React.ReactElement {
  const [open, setOpen] = useState<boolean>(false);

  const defaultProtocolTokens: Record<
    string,
    Array<{
      tokenAddress: string;
      tokenSymbol: string;
      tokenDecimals: number;
      amountHuman: string;
      periodSeconds: number;
    }>
  > = {};
  for (const allowance of role.allowances) {
    if (allowance.protocolSlug === "direct") {
      continue;
    }
    if (!defaultProtocolTokens[allowance.protocolSlug]) {
      defaultProtocolTokens[allowance.protocolSlug] = [];
    }
    defaultProtocolTokens[allowance.protocolSlug].push({
      tokenAddress: allowance.tokenAddress,
      tokenSymbol: allowance.tokenSymbol,
      tokenDecimals: allowance.tokenDecimals,
      amountHuman: weiToHuman(allowance.maxRefillWei, allowance.tokenDecimals),
      periodSeconds: allowance.periodSeconds,
    });
  }

  const defaultEnabledSlugs = role.protocols
    .filter((p) => p.protocolSlug !== "direct" && p.status === "allowed")
    .map((p) => p.protocolSlug);

  const defaultDirectRules: DirectRuleInput[] = (role.directRules ?? []).map(
    (r) => ({
      kind: r.kind as DirectRuleInput["kind"],
      tokenAddress: r.tokenAddress,
      tokenSymbol: r.tokenSymbol,
      tokenDecimals: r.tokenDecimals,
      counterparty: r.counterparty,
      amountHuman: r.amountHuman,
      periodSeconds: r.periodSeconds,
    })
  );

  const simulate = async (
    config: PolicyConfig
  ): Promise<SimulationPlan | null> => {
    const res = await fetch(`/api/user/safe/${safeId}/role/simulate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });
    const data = (await res.json()) as SimulationPlan | { error?: string };
    if (!res.ok || "error" in data) {
      const message =
        "error" in data
          ? (data.error ?? "Simulation failed")
          : "Simulation failed";
      throw new Error(message);
    }
    return data as SimulationPlan;
  };

  const handleConfirm = async (config: PolicyConfig): Promise<void> => {
    setEditing(true);
    try {
      const res = await fetch(`/api/user/safe/${safeId}/role/update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      const data = (await res.json()) as {
        success?: boolean;
        error?: string;
        noChanges?: boolean;
        addedProtocols?: number;
        removedProtocols?: number;
        addedAllowances?: number;
        changedAllowances?: number;
        revokedAllowances?: number;
      };
      if (!(res.ok && data.success)) {
        toast.error(data.error ?? "Update failed");
        return;
      }
      if (data.noChanges) {
        toast.info("No changes to apply");
      } else {
        const parts: string[] = [];
        if (data.addedProtocols) {
          parts.push(
            `+${data.addedProtocols} protocol${data.addedProtocols === 1 ? "" : "s"}`
          );
        }
        if (data.removedProtocols) {
          parts.push(
            `-${data.removedProtocols} protocol${data.removedProtocols === 1 ? "" : "s"}`
          );
        }
        if (data.addedAllowances) {
          parts.push(
            `+${data.addedAllowances} bucket${data.addedAllowances === 1 ? "" : "s"}`
          );
        }
        if (data.changedAllowances) {
          parts.push(
            `${data.changedAllowances} cap change${data.changedAllowances === 1 ? "" : "s"}`
          );
        }
        if (data.revokedAllowances) {
          parts.push(
            `-${data.revokedAllowances} bucket${data.revokedAllowances === 1 ? "" : "s"}`
          );
        }
        toast.success(
          parts.length > 0
            ? `Updated on chain: ${parts.join(", ")}`
            : "Updated on chain"
        );
      }
      setOpen(false);
      await onUpdated();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Update failed");
    } finally {
      setEditing(false);
    }
  };

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger asChild>
        <Button size="sm" type="button" variant="outline">
          Manage policies
        </Button>
      </DialogTrigger>
      <DialogContent className="thin-scrollbar flex max-h-[85vh] max-w-2xl flex-col gap-3 overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Manage on-chain policies</DialogTitle>
          <DialogDescription>
            Add or remove protocols, change token lists, or adjust per-period
            caps. The diff is computed against the current on-chain state and
            submitted as a single Safe transaction.
          </DialogDescription>
        </DialogHeader>
        <PolicyWizard
          chainId={chainId}
          confirmLabel="Apply changes"
          defaultDirectRules={defaultDirectRules}
          defaultEnabledSlugs={defaultEnabledSlugs}
          defaultProtocolTokens={defaultProtocolTokens}
          mode="edit"
          onCancel={() => setOpen(false)}
          onConfirm={handleConfirm}
          safeAddress={safeAddress}
          simulate={simulate}
          submitting={editing}
        />
      </DialogContent>
    </Dialog>
  );
}
