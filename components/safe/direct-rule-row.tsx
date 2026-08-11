"use client";

import { ethers } from "ethers";
import { ChevronDownIcon, ExternalLinkIcon, XIcon } from "lucide-react";
import Image from "next/image";
import { useCallback, useRef, useState } from "react";
import { AddressSelectPopover } from "@/components/address-book/address-select-popover";
import type {
  DirectRuleInput,
  DirectRuleKind,
} from "@/components/safe/policy-wizard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { POLICY_PERIOD_OPTIONS } from "./policy-token-row";
import { type PickedToken, TokenPicker } from "./token-picker";

/**
 * One direct-rule row inside the wizard. Encapsulates kind selector
 * (transfer / approve / native), token picker (ERC20 only), counterparty
 * input (recipient or spender depending on kind), amount + period, remove.
 */

type DirectRuleRowProps = {
  value: DirectRuleInput;
  chainId: number;
  onChange: (next: DirectRuleInput) => void;
  onRemove: () => void;
};

const RULE_KIND_OPTIONS: ReadonlyArray<{
  value: DirectRuleKind;
  label: string;
  counterpartyLabel: string;
  description: string;
}> = [
  {
    value: "erc20-transfer",
    label: "ERC20 transfer",
    counterpartyLabel: "Recipient",
    description:
      "Workflows can send the chosen token from the Safe to this recipient, up to the cap per period.",
  },
  {
    value: "erc20-approve",
    label: "ERC20 approve",
    counterpartyLabel: "Spender",
    description:
      "Workflows can call approve so this spender contract can pull the chosen token from the Safe, up to the cap per period.",
  },
  {
    value: "native-transfer",
    label: "Native ETH transfer",
    counterpartyLabel: "Recipient",
    description:
      "Workflows can send native ETH from the Safe to this recipient. The Roles modifier allowlists the recipient but does not cap the amount on chain.",
  },
];

function ruleKindMeta(
  kind: DirectRuleKind
): (typeof RULE_KIND_OPTIONS)[number] {
  return (
    RULE_KIND_OPTIONS.find((o) => o.value === kind) ?? RULE_KIND_OPTIONS[0]
  );
}

export function DirectRuleRow({
  value,
  chainId,
  onChange,
  onRemove,
}: DirectRuleRowProps): React.ReactElement {
  const [pickerOpen, setPickerOpen] = useState<boolean>(false);
  const [counterpartyFocused, setCounterpartyFocused] =
    useState<boolean>(false);
  const counterpartyBlurTimer = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const meta = ruleKindMeta(value.kind);
  const isNative = value.kind === "native-transfer";
  const counterpartyValid =
    value.counterparty.length === 0 || ethers.isAddress(value.counterparty);

  const handleCounterpartyBookmarkPick = useCallback(
    (address: string): void => {
      onChange({ ...value, counterparty: address });
      setCounterpartyFocused(false);
    },
    [onChange, value]
  );

  const handleCounterpartyBlur = useCallback((): void => {
    // Defer the close so a click inside the popover/command list still
    // registers before the popover unmounts. Mirrors the pattern in
    // SaveAddressBookmark so behavior is consistent across the app.
    if (counterpartyBlurTimer.current) {
      clearTimeout(counterpartyBlurTimer.current);
    }
    counterpartyBlurTimer.current = setTimeout(() => {
      const active = document.activeElement;
      const insidePopover = Boolean(
        active?.closest('[data-slot="popover-content"]') ||
          active?.closest('[data-slot="command"]')
      );
      if (!insidePopover) {
        setCounterpartyFocused(false);
      }
    }, 200);
  }, []);

  const handleKindChange = (next: string): void => {
    const kind = next as DirectRuleKind;
    if (kind === "native-transfer") {
      onChange({
        ...value,
        kind,
        tokenAddress: null,
        tokenSymbol: "ETH",
        tokenDecimals: 18,
      });
    } else {
      onChange({ ...value, kind });
    }
  };

  const handleTokenPicked = (picked: PickedToken): void => {
    onChange({
      ...value,
      tokenAddress: picked.tokenAddress,
      tokenSymbol: picked.tokenSymbol,
      tokenDecimals: picked.tokenDecimals,
      tokenLogoUrl: picked.logoUrl ?? null,
    });
  };

  return (
    <div className="space-y-2 rounded border bg-background p-3 text-sm">
      <div className="flex items-start gap-2">
        <Select onValueChange={handleKindChange} value={value.kind}>
          <SelectTrigger className="w-44 shrink-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RULE_KIND_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          {isNative ? (
            <div className="flex h-9 w-full items-center justify-between rounded-md border bg-muted/40 px-3 text-muted-foreground text-sm">
              <span className="font-medium">ETH</span>
              <span className="text-xs">native</span>
            </div>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  aria-label={
                    value.tokenSymbol
                      ? `Change token (currently ${value.tokenSymbol})`
                      : "Pick a token"
                  }
                  className="flex h-9 w-full items-center gap-2 rounded-md border bg-background px-3 text-sm hover:border-primary focus:outline-none focus:ring-2 focus:ring-ring"
                  onClick={() => setPickerOpen(true)}
                  type="button"
                >
                  {value.tokenLogoUrl && (
                    <Image
                      alt={value.tokenSymbol || "token"}
                      className="h-5 w-5 shrink-0 rounded-full bg-muted"
                      height={20}
                      src={value.tokenLogoUrl}
                      width={20}
                    />
                  )}
                  <span
                    className={
                      value.tokenSymbol
                        ? "flex-1 text-left font-medium"
                        : "flex-1 text-left text-muted-foreground"
                    }
                  >
                    {value.tokenSymbol || "Pick a token"}
                  </span>
                  <ChevronDownIcon
                    aria-hidden="true"
                    className="h-4 w-4 shrink-0 text-muted-foreground"
                  />
                </button>
              </TooltipTrigger>
              <TooltipContent className="font-mono text-xs">
                {value.tokenAddress ?? "Click to pick a token"}
              </TooltipContent>
            </Tooltip>
          )}
        </div>

        <Button
          aria-label="Remove rule"
          onClick={onRemove}
          size="icon"
          type="button"
          variant="ghost"
        >
          <XIcon className="h-4 w-4" />
        </Button>
      </div>

      <div className="text-muted-foreground text-xs">{meta.description}</div>

      <div className="grid gap-2 sm:grid-cols-[2fr_1fr_1fr]">
        <div className="space-y-1">
          <Label className="text-xs" htmlFor={`direct-rule-cp-${value.kind}`}>
            {meta.counterpartyLabel} address
          </Label>
          <AddressSelectPopover
            isOpen={counterpartyFocused}
            onAddressSelect={handleCounterpartyBookmarkPick}
            onClose={() => setCounterpartyFocused(false)}
          >
            <Input
              className={counterpartyValid ? undefined : "border-destructive"}
              id={`direct-rule-cp-${value.kind}`}
              onBlur={handleCounterpartyBlur}
              onChange={(e) =>
                onChange({ ...value, counterparty: e.target.value })
              }
              onFocus={() => setCounterpartyFocused(true)}
              placeholder="0x..."
              value={value.counterparty}
            />
          </AddressSelectPopover>
          {!counterpartyValid && (
            <div className="text-destructive text-xs">
              Must be a valid 0x... address
            </div>
          )}
        </div>

        <div className="space-y-1">
          <Label
            className="text-xs"
            htmlFor={`direct-rule-amount-${value.kind}`}
          >
            Max {isNative ? "value" : "amount"}
          </Label>
          <Input
            id={`direct-rule-amount-${value.kind}`}
            inputMode="decimal"
            onChange={(e) =>
              onChange({ ...value, amountHuman: e.target.value })
            }
            placeholder="100"
            value={value.amountHuman}
          />
        </div>

        <div className="space-y-1">
          <Label
            className="text-xs"
            htmlFor={`direct-rule-period-${value.kind}`}
          >
            Period
          </Label>
          <Select
            disabled={isNative}
            onValueChange={(next) =>
              onChange({ ...value, periodSeconds: Number(next) })
            }
            value={String(value.periodSeconds)}
          >
            <SelectTrigger id={`direct-rule-period-${value.kind}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {POLICY_PERIOD_OPTIONS.map((o) => (
                <SelectItem key={o.seconds} value={String(o.seconds)}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {isNative && (
        <div className="flex items-start gap-1 rounded border border-amber-300/40 bg-amber-500/5 p-2 text-amber-600/80 text-xs">
          <span>
            Native ETH rules only allowlist the recipient address; the Zodiac
            Roles modifier does not enforce per-period value caps on raw ETH
            sends. ERC-20 rules below pin both the recipient and the per-period
            amount on chain.
          </span>
          {value.counterparty && counterpartyValid && (
            <a
              aria-label="View recipient on explorer"
              className="ml-auto inline-flex shrink-0 items-center"
              href={`https://etherscan.io/address/${value.counterparty}`}
              rel="noopener noreferrer"
              target="_blank"
            >
              <ExternalLinkIcon className="h-3 w-3" />
            </a>
          )}
        </div>
      )}

      <TokenPicker
        chainId={chainId}
        excludeAddresses={[]}
        onOpenChange={setPickerOpen}
        onSelect={handleTokenPicked}
        open={pickerOpen}
      />
    </div>
  );
}
