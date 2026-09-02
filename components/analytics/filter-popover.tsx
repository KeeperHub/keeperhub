"use client";

import { Check, ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

type FilterPopoverProps = {
  label: string;
  /** Number of values held in this dimension; 0 renders no badge. */
  selectedCount: number;
  onClear: () => void;
  /** Omitted by a single-choice dimension, which has nothing to select all of. */
  onSelectAll?: () => void;
  children: ReactNode;
};

/** A filter dimension: a trigger showing how many values it holds, and a panel. */
export function FilterPopover({
  label,
  selectedCount,
  onClear,
  onSelectAll,
  children,
}: FilterPopoverProps): ReactNode {
  const slug = label.toLowerCase().replace(/\s+/g, "-");
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          className={cn(
            "h-8 gap-1.5 px-2.5 text-xs",
            selectedCount > 0 && "border-primary/40"
          )}
          data-testid={`filter-${slug}`}
          size="sm"
          variant="outline"
        >
          {label}
          {selectedCount > 0 && (
            <Badge className="h-4 px-1 text-[10px]" variant="secondary">
              {selectedCount}
            </Badge>
          )}
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-64 p-0"
        data-testid={`filter-${slug}-panel`}
      >
        <div className="max-h-80 overflow-y-auto p-1.5">{children}</div>
        <div className="flex items-center justify-between border-t px-2 py-1.5">
          <span className="text-[11px] text-muted-foreground">
            {selectedCount > 0 ? `${selectedCount} selected` : "Showing all"}
          </span>
          <div className="flex items-center gap-1">
            {onSelectAll ? (
              <Button
                className="h-6 px-2 text-xs"
                onClick={onSelectAll}
                size="sm"
                variant="ghost"
              >
                Select all
              </Button>
            ) : null}
            <Button
              className="h-6 px-2 text-xs"
              disabled={selectedCount === 0}
              onClick={onClear}
              size="sm"
              variant="ghost"
            >
              Clear
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

type FilterCheckboxProps = {
  label: string;
  /** Tailwind background class for the status swatch, when the row has one. */
  dot?: string;
  count?: number;
  checked: boolean;
  /** Some but not all of a group's members are selected. */
  indeterminate?: boolean;
  indented?: boolean;
  onToggle: () => void;
};

export function FilterCheckbox({
  label,
  dot,
  count,
  checked,
  indeterminate = false,
  indented = false,
  onToggle,
}: FilterCheckboxProps): ReactNode {
  return (
    <button
      className={cn(
        "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent",
        indented && "pl-7"
      )}
      onClick={onToggle}
      type="button"
    >
      <Checkbox
        checked={indeterminate ? "indeterminate" : checked}
        className="pointer-events-none"
        tabIndex={-1}
      />
      {dot ? (
        <span className={cn("size-2 shrink-0 rounded-full", dot)} />
      ) : null}
      <span className={cn("flex-1", !indented && "font-medium")}>{label}</span>
      {count !== undefined && (
        <span className="text-[11px] text-muted-foreground tabular-nums">
          {count}
        </span>
      )}
    </button>
  );
}

type FilterRadioProps = {
  label: string;
  checked: boolean;
  onSelect: () => void;
};

export function FilterRadio({
  label,
  checked,
  onSelect,
}: FilterRadioProps): ReactNode {
  return (
    <button
      className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent"
      onClick={onSelect}
      type="button"
    >
      <Check
        className={cn("size-3.5", checked ? "opacity-100" : "opacity-0")}
      />
      <span className="flex-1">{label}</span>
    </button>
  );
}
