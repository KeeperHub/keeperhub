"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
  type PolicyConfig,
  PolicyWizard,
  type SimulationPlan,
} from "@/components/safe/policy-wizard";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

type Props = {
  safeId: string;
  chainId: number;
  safeAddress?: string;
  installing: boolean;
  setInstalling: (value: boolean) => void;
  onInstalled: () => Promise<void>;
};

export function RoleInstallDialog({
  safeId,
  chainId,
  safeAddress,
  installing,
  setInstalling,
  onInstalled,
}: Props): React.ReactElement {
  const [open, setOpen] = useState<boolean>(false);

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

  const handleInstall = async (config: PolicyConfig): Promise<void> => {
    setInstalling(true);
    try {
      const res = await fetch(`/api/user/safe/${safeId}/role`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      const data = (await res.json()) as {
        success?: boolean;
        error?: string;
        skipped?: string[];
      };
      if (!(res.ok && data.success)) {
        toast.error(data.error ?? "Install failed");
        return;
      }
      if (data.skipped && data.skipped.length > 0) {
        toast.warning(
          `Skipped protocols not available on this chain: ${data.skipped.join(", ")}`
        );
      }
      toast.success(`Zodiac Roles installed on chain ${chainId}`);
      setOpen(false);
      await onInstalled();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Install failed");
    } finally {
      setInstalling(false);
    }
  };

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger asChild>
        <Button className="w-full" type="button">
          Enable on-chain policies
        </Button>
      </DialogTrigger>
      <DialogContent className="thin-scrollbar flex max-h-[85vh] max-w-2xl flex-col gap-3 overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Install Zodiac Roles</DialogTitle>
          <DialogDescription>
            Scope workflow execution on this Safe to the selected protocols and
            per-token limits. Review shows every on-chain operation and the
            estimated gas cost before you confirm.
          </DialogDescription>
        </DialogHeader>
        <PolicyWizard
          chainId={chainId}
          confirmLabel="Confirm & install"
          defaultEnabledSlugs={[]}
          onCancel={() => setOpen(false)}
          onConfirm={handleInstall}
          safeAddress={safeAddress}
          simulate={simulate}
          submitting={installing}
        />
      </DialogContent>
    </Dialog>
  );
}
