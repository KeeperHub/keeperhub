"use client";

import { Pencil } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { POLICY_PERIOD_OPTIONS } from "./policy-token-row";

export type RoleAllowance = {
  id: string;
  protocolSlug: string;
  tokenAddress: string;
  tokenSymbol: string;
  tokenDecimals: number;
  maxRefillWei: string;
  refillWei: string;
  periodSeconds: number;
  lastChainBalanceWei: string | null;
};

type Props = {
  allowance: RoleAllowance;
  safeId: string;
  isAdmin: boolean;
  /**
   * Strict-subset gate for the Revoke button. Revoking an allowance writes
   * a zero-out call to the on-chain Roles modifier; we restrict that to
   * the org owner. Admins still see the disabled button + a tooltip
   * explaining why; members (`!isAdmin`) never see the button at all.
   */
  isOwner: boolean;
  onRevoked: () => Promise<void>;
  /** Optional pencil-edit callback. When provided, a pencil button shows on
   * row hover so admins can open the per-allowance edit modal. */
  onEdit?: () => void;
};

function periodLabel(seconds: number): string {
  const match = POLICY_PERIOD_OPTIONS.find((o) => o.seconds === seconds);
  if (match) {
    return match.label;
  }
  return `${seconds}s`;
}

function formatWei(amount: string, decimals: number): string {
  try {
    const big = BigInt(amount);
    const divisor = BigInt(10) ** BigInt(decimals);
    const whole = big / divisor;
    const remainder = big % divisor;
    const remainderStr = remainder
      .toString()
      .padStart(decimals, "0")
      .slice(0, 4);
    return `${whole.toString()}.${remainderStr}`;
  } catch {
    return amount;
  }
}

export function RoleAllowanceRow({
  allowance,
  safeId,
  isAdmin,
  isOwner,
  onRevoked,
  onEdit,
}: Props): React.ReactElement {
  const [revoking, setRevoking] = useState<boolean>(false);

  const handleRevoke = async (): Promise<void> => {
    setRevoking(true);
    try {
      const params = new URLSearchParams({
        protocolSlug: allowance.protocolSlug,
      });
      const res = await fetch(
        `/api/user/safe/${safeId}/role/allowances/${allowance.tokenAddress}?${params.toString()}`,
        { method: "DELETE" }
      );
      const data = (await res.json()) as { success?: boolean; error?: string };
      if (!(res.ok && data.success)) {
        toast.error(data.error ?? "Revoke failed");
        return;
      }
      toast.success(`Revoked ${allowance.tokenSymbol} allowance`);
      await onRevoked();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Revoke failed");
    } finally {
      setRevoking(false);
    }
  };

  const remaining = allowance.lastChainBalanceWei ?? allowance.maxRefillWei;
  const remainingHuman = formatWei(remaining, allowance.tokenDecimals);
  const capHuman = formatWei(allowance.maxRefillWei, allowance.tokenDecimals);

  const showEditButton = isAdmin && onEdit !== undefined;

  return (
    <li className="group flex items-center gap-1 rounded border bg-muted/20 px-3 py-2 text-sm">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium">{allowance.tokenSymbol}</span>
          <span className="text-muted-foreground text-xs">
            {remainingHuman} / {capHuman} left
          </span>
        </div>
        <div className="text-muted-foreground text-xs">
          Refills {periodLabel(allowance.periodSeconds)}
        </div>
      </div>
      {showEditButton && (
        <Button
          aria-label={`Edit ${allowance.tokenSymbol} allowance`}
          className="h-7 w-0 overflow-hidden p-0 text-muted-foreground opacity-0 transition-all duration-150 focus-visible:w-7 focus-visible:opacity-100 group-hover:w-7 group-hover:opacity-100"
          onClick={onEdit}
          size="sm"
          type="button"
          variant="ghost"
        >
          <Pencil className="h-3.5 w-3.5" />
        </Button>
      )}
      {isAdmin &&
        (isOwner ? (
          <Button
            aria-label={`Revoke ${allowance.tokenSymbol} allowance`}
            disabled={revoking}
            onClick={handleRevoke}
            size="sm"
            type="button"
            variant="ghost"
          >
            {revoking ? <Spinner className="h-4 w-4" /> : "Revoke"}
          </Button>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">
                <Button
                  aria-disabled
                  aria-label={`Revoke ${allowance.tokenSymbol} allowance (owner only)`}
                  disabled
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Revoke
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>
              Only the organization owner can revoke an on-chain allowance.
            </TooltipContent>
          </Tooltip>
        ))}
    </li>
  );
}
