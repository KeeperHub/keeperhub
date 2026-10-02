"use client";

import { AlertTriangle } from "lucide-react";
import { SwitchField } from "@/components/workflow/config/switch-field";
import { resolveSponsorGas } from "@/lib/web3/sponsorship-feature-flag";

type SponsorGasFieldProps = {
  id: string;
  label: string;
  description?: string;
  value: unknown;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
};

/**
 * The "Sponsor gas" toggle, with the consequence of switching it off spelled
 * out underneath.
 *
 * The warning is not decoration. Off means the sending wallet pays the fee
 * itself, so a wallet that was only ever funded with the value it moves now
 * fails at broadcast for want of native token. Read as a bare switch among
 * the other Advanced settings, this looks like a preference; it is a change
 * of who pays.
 */
export function SponsorGasField({
  id,
  label,
  description,
  value,
  onChange,
  disabled,
}: SponsorGasFieldProps) {
  const sponsored = resolveSponsorGas(value);

  return (
    <div className="space-y-2">
      <SwitchField
        checked={sponsored}
        description={description}
        disabled={disabled}
        id={id}
        label={label}
        onChange={onChange}
      />
      {!sponsored && (
        <div className="flex items-start gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-amber-700 text-xs dark:text-amber-300">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span className="break-words">
            This action pays its own gas from the sending wallet's native
            balance and uses no gas credits. The wallet must hold enough to
            cover the fee, or the run fails at broadcast.
          </span>
        </div>
      )}
    </div>
  );
}
