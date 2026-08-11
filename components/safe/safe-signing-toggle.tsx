"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type PatchResponse = {
  success?: boolean;
  safe?: { isSigningActive: boolean };
  error?: string;
};

type SafeSigningToggleProps = {
  safeId: string;
  chainLabel: string;
  isActive: boolean;
  isAdmin: boolean;
  onChange: (next: boolean) => void;
  /**
   * Compact inline variant: just `[Sender label + spinner + Switch]` for use
   * directly in the wallet account row. Default `false` renders the bordered
   * card with the longer explanation, suitable for a settings panel.
   */
  compact?: boolean;
};

export function SafeSigningToggle({
  safeId,
  chainLabel,
  isActive,
  isAdmin,
  onChange,
  compact = false,
}: SafeSigningToggleProps): React.ReactElement {
  const [submitting, setSubmitting] = useState<boolean>(false);
  const inputId = `safe-signing-${safeId}`;

  const handleChange = async (next: boolean): Promise<void> => {
    setSubmitting(true);
    try {
      const res = await fetch(`/api/user/safe/${safeId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isSigningActive: next }),
      });
      const data = (await res.json()) as PatchResponse;
      if (!(res.ok && data.success && data.safe)) {
        toast.error(data.error ?? "Failed to update signing mode");
        return;
      }
      onChange(data.safe.isSigningActive);
      toast.success(
        next
          ? `Workflows on ${chainLabel} will execute from the Safe`
          : `Workflows on ${chainLabel} will execute from the Turnkey EOA`
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to update signing mode"
      );
    } finally {
      setSubmitting(false);
    }
  };

  if (compact) {
    const labelColor = isActive
      ? "text-emerald-600 dark:text-emerald-400"
      : "text-muted-foreground";
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex shrink-0 items-center gap-1.5">
            {submitting && <Spinner className="h-3 w-3" />}
            <Label
              className={`font-medium text-[10px] uppercase tracking-wide ${labelColor}`}
              htmlFor={inputId}
            >
              Sender
            </Label>
            <Switch
              checked={isActive}
              className="data-[state=checked]:bg-emerald-500"
              disabled={!isAdmin || submitting}
              id={inputId}
              onCheckedChange={handleChange}
            />
          </div>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs" side="bottom">
          {isActive
            ? `This Safe is the active SENDER on ${chainLabel}. Workflow nodes set to "Default Sender" sign through this Safe; funds and msg.sender come from the Safe. Flip off to route those nodes through the Turnkey EOA instead.`
            : `No SENDER is active on ${chainLabel}. Workflow nodes set to "Default Sender" currently sign through the Turnkey EOA. Flip on to make this Safe the SENDER; msg.sender becomes the Safe and funds come from the Safe (the EOA still pays gas).`}
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <div className="flex items-start justify-between gap-3 rounded-md border bg-muted/20 p-3">
      <div className="flex-1">
        <Label className="cursor-pointer font-medium text-xs" htmlFor={inputId}>
          Mark this Safe as Sender on {chainLabel}
        </Label>
        <p className="mt-0.5 text-muted-foreground text-xs">
          When ON, workflow nodes set to "Default Sender" route through this
          Safe. The Safe is msg.sender, and its balance funds native sends,
          ERC-20 transfers, approvals, swaps, and protocol deposits. The Turnkey
          EOA still signs the outer transaction and pays gas. Fund the Safe
          before turning this on.
        </p>
      </div>
      <div className="flex items-center gap-2 pt-0.5">
        {submitting && <Spinner className="h-3 w-3" />}
        <Switch
          checked={isActive}
          disabled={!isAdmin || submitting}
          id={inputId}
          onCheckedChange={handleChange}
        />
      </div>
    </div>
  );
}
