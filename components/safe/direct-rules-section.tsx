"use client";

import { InfoIcon } from "lucide-react";
import { AddressWithExplorer } from "@/components/safe/address-with-explorer";
import type { DirectRuleInput } from "@/components/safe/policy-wizard";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { DirectRuleRow } from "./direct-rule-row";
import { POLICY_PERIOD_OPTIONS } from "./policy-token-row";

const DEFAULT_PERIOD_SECONDS = POLICY_PERIOD_OPTIONS[1].seconds;

type DirectRulesSectionProps = {
  rules: DirectRuleInput[];
  chainId: number;
  safeAddress?: string;
  onChange: (next: DirectRuleInput[]) => void;
};

function makeBlankRule(): DirectRuleInput {
  return {
    kind: "erc20-transfer",
    tokenAddress: null,
    tokenSymbol: "",
    tokenDecimals: 18,
    counterparty: "",
    amountHuman: "",
    periodSeconds: DEFAULT_PERIOD_SECONDS,
  };
}

export function DirectRulesSection({
  rules,
  chainId,
  safeAddress,
  onChange,
}: DirectRulesSectionProps): React.ReactElement {
  const updateAt = (index: number, next: DirectRuleInput): void => {
    const copy = rules.slice();
    copy[index] = next;
    onChange(copy);
  };

  const removeAt = (index: number): void => {
    const copy = rules.slice();
    copy.splice(index, 1);
    onChange(copy);
  };

  const addRule = (): void => {
    onChange([...rules, makeBlankRule()]);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <Label className="text-xs">Direct transfers and approvals</Label>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              aria-label="How direct rules work"
              className="text-muted-foreground transition-colors hover:text-foreground"
              type="button"
            >
              <InfoIcon className="h-3.5 w-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs" side="right">
            <ul className="list-inside list-disc space-y-1">
              <li>
                Each rule authorises one specific transfer, approval, or native
                ETH send from this Safe through workflows.
              </li>
              <li>
                Per rule you pick a token, a recipient or spender, and a
                per-period cap.
              </li>
              <li>
                Workflows can call only those functions for that exact
                counterparty up to the cap. Anything else reverts on chain.
              </li>
            </ul>
          </TooltipContent>
        </Tooltip>
      </div>
      {safeAddress && (
        <div className="flex flex-wrap items-center gap-1 text-muted-foreground text-xs">
          <span>Safe being scoped:</span>
          <AddressWithExplorer address={safeAddress} chainId={chainId} />
        </div>
      )}
      <ul className="space-y-2">
        {rules.map((rule, idx) => (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: rule rows are anonymous; index is stable for the row's lifetime in the list
            key={`direct-rule-${idx}`}
          >
            <DirectRuleRow
              chainId={chainId}
              onChange={(next) => updateAt(idx, next)}
              onRemove={() => removeAt(idx)}
              value={rule}
            />
          </li>
        ))}
      </ul>
      <Button onClick={addRule} size="sm" type="button" variant="outline">
        + Add rule
      </Button>
    </div>
  );
}
