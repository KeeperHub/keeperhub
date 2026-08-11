"use client";

import { Pencil } from "lucide-react";
import Image from "next/image";
import { AddressWithExplorer } from "@/components/safe/address-with-explorer";
import { POLICY_PERIOD_OPTIONS } from "@/components/safe/policy-token-row";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getTokenInfo } from "@/lib/contracts/tokens";

export type RoleDirectRule = {
  id: string;
  kind: string;
  tokenAddress: string | null;
  tokenSymbol: string;
  tokenDecimals: number;
  counterparty: string;
  amountHuman: string;
  periodSeconds: number;
  status: string;
};

export type RoleDirectRuleAllowance = {
  maxRefillWei: string;
  lastChainBalanceWei: string | null;
  tokenDecimals: number;
};

type Props = {
  rule: RoleDirectRule;
  chainId: number;
  /**
   * On-chain allowance bucket for this rule's token, used to render
   * "remaining / cap left". Native rules have no bucket.
   */
  allowance?: RoleDirectRuleAllowance | null;
  /** Optional logo URL for the token, sourced from supported tokens. */
  tokenLogoUrl?: string | null;
  /** Callback to open the per-rule edit dialog; only rendered when set. */
  onEdit?: () => void;
};

function kindLabel(kind: string): string {
  if (kind === "erc20-transfer") {
    return "Transfer";
  }
  if (kind === "erc20-approve") {
    return "Approve";
  }
  if (kind === "native-transfer") {
    return "Native send";
  }
  return kind;
}

function counterpartyRole(kind: string): string {
  if (kind === "erc20-approve") {
    return "Spender";
  }
  return "Recipient";
}

function periodLabel(seconds: number): string {
  const match = POLICY_PERIOD_OPTIONS.find((o) => o.seconds === seconds);
  return match?.label ?? `${seconds}s`;
}

function formatWei(amount: string, decimals: number): string {
  try {
    const big = BigInt(amount);
    if (decimals === 0) {
      return big.toString();
    }
    const divisor = BigInt(10) ** BigInt(decimals);
    const whole = big / divisor;
    const remainder = big % divisor;
    const remainderStr = remainder
      .toString()
      .padStart(decimals, "0")
      .slice(0, 4);
    return `${whole}.${remainderStr}`;
  } catch {
    return amount;
  }
}

export function RoleDirectRuleRow({
  rule,
  chainId,
  allowance,
  tokenLogoUrl,
  onEdit,
}: Props): React.ReactElement {
  const isNative = rule.kind === "native-transfer";
  let usageText: string;
  if (allowance) {
    const remaining = allowance.lastChainBalanceWei ?? allowance.maxRefillWei;
    const remainingHuman = formatWei(remaining, allowance.tokenDecimals);
    const capHuman = formatWei(allowance.maxRefillWei, allowance.tokenDecimals);
    usageText = `${remainingHuman} / ${capHuman} ${rule.tokenSymbol} left`;
  } else if (isNative) {
    usageText = `cap ${rule.amountHuman} ${rule.tokenSymbol}`;
  } else {
    usageText = `cap ${rule.amountHuman} ${rule.tokenSymbol}`;
  }

  const tokenInfo = rule.tokenAddress
    ? getTokenInfo(chainId, rule.tokenAddress)
    : null;
  const logoUrl = tokenLogoUrl ?? tokenInfo?.logoUrl ?? null;

  return (
    <li className="group flex items-center gap-1 rounded border bg-muted/20 px-3 py-2 text-sm">
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge className="text-[10px]" variant="outline">
            {kindLabel(rule.kind)}
          </Badge>
          {logoUrl ? (
            <Image
              alt={rule.tokenSymbol}
              className="h-5 w-5 shrink-0 rounded-full bg-muted"
              height={20}
              src={logoUrl}
              width={20}
            />
          ) : (
            <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted font-medium text-[9px]">
              {rule.tokenSymbol.slice(0, 3)}
            </div>
          )}
          <span className="font-medium">{rule.tokenSymbol}</span>
          <span className="text-muted-foreground text-xs">
            {usageText} · Refills {periodLabel(rule.periodSeconds)}
          </span>
        </div>
        <div className="flex items-center gap-2 text-muted-foreground text-xs">
          <span>{counterpartyRole(rule.kind)}</span>
          <AddressWithExplorer address={rule.counterparty} chainId={chainId} />
        </div>
      </div>
      {onEdit && (
        <Button
          aria-label="Edit rule"
          className="h-7 w-0 overflow-hidden p-0 text-muted-foreground opacity-0 transition-all duration-150 focus-visible:w-7 focus-visible:opacity-100 group-hover:w-7 group-hover:opacity-100"
          onClick={onEdit}
          size="sm"
          type="button"
          variant="ghost"
        >
          <Pencil className="h-3.5 w-3.5" />
        </Button>
      )}
    </li>
  );
}
