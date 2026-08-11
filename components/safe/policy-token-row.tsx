"use client";

import { ExternalLinkIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

/**
 * One row inside a protocol card: symbol badge + truncated address with
 * explorer link + amount input + period selector + remove button.
 *
 * Owns no state; the parent is responsible for updating the token list.
 */

export type TokenRowValue = {
  tokenAddress: string;
  tokenSymbol: string;
  tokenDecimals: number;
  amountHuman: string;
  periodSeconds: number;
  explorerUrl?: string | null;
};

const DAY = 86_400;
const WEEK = 604_800;
const MONTH = 2_592_000;

export const POLICY_PERIOD_OPTIONS: ReadonlyArray<{
  label: string;
  seconds: number;
}> = [
  { label: "Daily", seconds: DAY },
  { label: "Weekly", seconds: WEEK },
  { label: "Monthly", seconds: MONTH },
] as const;

type PolicyTokenRowProps = {
  value: TokenRowValue;
  onChange: (next: TokenRowValue) => void;
  onRemove: () => void;
};

export function PolicyTokenRow({
  value,
  onChange,
  onRemove,
}: PolicyTokenRowProps): React.ReactElement {
  const periodValue = String(value.periodSeconds);

  return (
    <div className="flex flex-wrap items-center gap-2 rounded border bg-background p-2 text-sm">
      <div className="flex min-w-0 items-center gap-1.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex shrink-0 items-center rounded-full border bg-muted px-2.5 py-0.5 font-medium text-xs">
              {value.tokenSymbol}
            </span>
          </TooltipTrigger>
          <TooltipContent className="font-mono text-xs">
            {value.tokenAddress}
          </TooltipContent>
        </Tooltip>
        {value.explorerUrl && (
          <a
            aria-label="View on explorer"
            className="inline-flex shrink-0 items-center text-muted-foreground hover:text-foreground"
            href={value.explorerUrl}
            rel="noopener noreferrer"
            target="_blank"
          >
            <ExternalLinkIcon className="h-3 w-3" />
          </a>
        )}
      </div>

      <Input
        className="min-w-0 flex-1"
        inputMode="decimal"
        onChange={(e) => onChange({ ...value, amountHuman: e.target.value })}
        placeholder="100"
        value={value.amountHuman}
      />

      <Select
        onValueChange={(next) =>
          onChange({ ...value, periodSeconds: Number(next) })
        }
        value={periodValue}
      >
        <SelectTrigger className="min-w-0 flex-1">
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

      <Button
        aria-label="Remove token"
        onClick={onRemove}
        size="icon"
        type="button"
        variant="ghost"
      >
        <XIcon className="h-4 w-4" />
      </Button>
    </div>
  );
}
