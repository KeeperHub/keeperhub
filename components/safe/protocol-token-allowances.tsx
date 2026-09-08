"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  POLICY_PERIOD_OPTIONS,
  PolicyTokenRow,
  type TokenRowValue,
} from "./policy-token-row";
import { type PickedToken, TokenPicker } from "./token-picker";

/**
 * Token allowance editor for a single protocol bucket. Renders one
 * `<PolicyTokenRow>` per `TokenRowValue` plus an Add button that opens
 * the chain-aware `<TokenPicker>`.
 *
 * The component is fully controlled: tokens live in the parent's state
 * so that hiding or re-mounting this component (e.g. when collapsing
 * the protocol card or toggling a protocol off) never loses the admin's
 * configured caps.
 */

const DEFAULT_PERIOD = POLICY_PERIOD_OPTIONS[1].seconds;

type ProtocolTokenAllowancesProps = {
  chainId: number;
  tokens: TokenRowValue[];
  onChange: (next: TokenRowValue[]) => void;
  /**
   * Optional copy override for the empty state. Defaults to a generic
   * prompt; protocol cards can swap in protocol-specific guidance.
   */
  emptyCopy?: string;
  /** Optional Add-button label override. */
  addLabel?: string;
};

export function ProtocolTokenAllowances({
  chainId,
  tokens,
  onChange,
  emptyCopy = "No tokens added yet. Click Add token to scope which tokens this protocol can spend.",
  addLabel = "+ Add token",
}: ProtocolTokenAllowancesProps): React.ReactElement {
  const [pickerOpen, setPickerOpen] = useState<boolean>(false);

  const handleTokenPicked = (picked: PickedToken): void => {
    const next: TokenRowValue = {
      tokenAddress: picked.tokenAddress,
      tokenSymbol: picked.tokenSymbol,
      tokenDecimals: picked.tokenDecimals,
      amountHuman: "",
      periodSeconds: DEFAULT_PERIOD,
      explorerUrl: picked.explorerUrl ?? null,
    };
    onChange([...tokens, next]);
  };

  const updateTokenAt = (index: number, value: TokenRowValue): void => {
    const copy = tokens.slice();
    copy[index] = value;
    onChange(copy);
  };

  const removeTokenAt = (index: number): void => {
    const copy = tokens.slice();
    copy.splice(index, 1);
    onChange(copy);
  };

  return (
    <div className="space-y-2">
      {tokens.length === 0 && (
        <div className="rounded bg-muted/20 p-2 text-muted-foreground text-xs">
          {emptyCopy}
        </div>
      )}
      {tokens.map((t, idx) => (
        <PolicyTokenRow
          key={t.tokenAddress}
          onChange={(next) => updateTokenAt(idx, next)}
          onRemove={() => removeTokenAt(idx)}
          value={t}
        />
      ))}
      <Button
        onClick={() => setPickerOpen(true)}
        size="sm"
        type="button"
        variant="outline"
      >
        {addLabel}
      </Button>
      <TokenPicker
        chainId={chainId}
        excludeAddresses={tokens.map((t) => t.tokenAddress)}
        onOpenChange={setPickerOpen}
        onSelect={handleTokenPicked}
        open={pickerOpen}
      />
    </div>
  );
}
