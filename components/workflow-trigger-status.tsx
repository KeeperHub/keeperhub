"use client";

import { Check, ListFilter } from "lucide-react";
import { SearchInput } from "@/components/ui/search-input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { getTriggerIcon } from "@/components/workflow-trigger-icons";
import { cn } from "@/lib/utils";
import type { WorkflowTriggerType } from "@/lib/workflow/store";
import {
  getTriggerTypeLabel,
  type TriggerFilter,
  type TriggerStatus,
  type TriggerStatusCounts,
} from "@/lib/workflow/trigger-display";

// Tooltips here wait this long, so a pointer moving down the list does not
// open one on every row it passes.
export const TOOLTIP_DELAY_MS = 400;

/**
 * The trigger-type icon at the start of a picker row. Green only when the
 * workflow will fire on its own; grey when it is disabled and, always, for
 * Manual, which has no enabled state.
 */
export function TriggerStatusIcon({
  triggerType,
  status,
  tooltip,
}: {
  triggerType: WorkflowTriggerType | undefined;
  status: TriggerStatus;
  // Defaults to the bare type, e.g. "Block trigger".
  tooltip?: string;
}): React.ReactNode {
  const Icon = getTriggerIcon(triggerType);
  return (
    <Tooltip delayDuration={TOOLTIP_DELAY_MS}>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "flex size-5 shrink-0 items-center justify-center rounded-md border transition-colors duration-150 motion-reduce:transition-none",
            status === "enabled"
              ? "border-keeperhub-green/30 bg-keeperhub-green/10 text-keeperhub-green"
              : "border-foreground/15 text-muted-foreground"
          )}
          data-testid="trigger-status-icon"
          data-trigger-status={status}
          data-trigger-type={triggerType ?? "Manual"}
        >
          <Icon aria-hidden="true" className="size-3" />
        </span>
      </TooltipTrigger>
      <TooltipContent className="pointer-events-none" side="top">
        {tooltip ?? getTriggerTypeLabel(triggerType)}
      </TooltipContent>
    </Tooltip>
  );
}

// The search field and chips that the filter button shows and hides.
export const TRIGGER_FILTER_PANEL_ID = "workflow-trigger-filter";

export function TriggerFilterButton({
  open,
  onToggle,
  ref,
  disabled = false,
}: {
  open: boolean;
  onToggle: () => void;
  ref?: React.Ref<HTMLButtonElement>;
  // While the workflows load there is nothing to filter yet.
  disabled?: boolean;
}): React.ReactNode {
  const label = open ? "Hide filter and search" : "Filter and search";
  return (
    <Tooltip delayDuration={TOOLTIP_DELAY_MS}>
      <TooltipTrigger asChild>
        <button
          aria-controls={open ? TRIGGER_FILTER_PANEL_ID : undefined}
          aria-expanded={open}
          aria-label={label}
          className={cn(
            "size-6 shrink-0 rounded-md border p-1 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-foreground/60 disabled:pointer-events-none disabled:opacity-40",
            open
              ? "border-foreground/40 bg-foreground/10 text-foreground"
              : "border-transparent text-muted-foreground hover:bg-muted hover:text-foreground"
          )}
          data-testid="trigger-filter-button"
          disabled={disabled}
          onClick={onToggle}
          ref={ref}
          type="button"
        >
          <ListFilter className="size-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

const FILTER_OPTIONS: ReadonlyArray<{ value: TriggerStatus; label: string }> = [
  { value: "enabled", label: "Enabled" },
  { value: "disabled", label: "Disabled" },
  { value: "manual", label: "Manual" },
];

function FilterChip({
  selected,
  count,
  value,
  onClick,
  children,
}: {
  selected: boolean;
  count: number;
  value: string;
  onClick: () => void;
  children: React.ReactNode;
}): React.ReactNode {
  return (
    <button
      aria-pressed={selected}
      className={cn(
        "flex h-6 items-center gap-1 rounded-full border px-2.5 text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-foreground/60",
        selected
          ? "border-foreground/40 bg-foreground/10 font-medium text-foreground"
          : "border-border text-muted-foreground hover:bg-muted/50",
        // Picking it would empty the list; it stays clickable all the same.
        count === 0 && !selected && "opacity-70"
      )}
      data-filter={value}
      onClick={onClick}
      type="button"
    >
      {selected && <Check aria-hidden="true" className="size-3" />}
      {children} {count}
    </button>
  );
}

/**
 * Status chips that combine: Enabled and Disabled together show both. All
 * is selected while nothing else is, and clicking it clears the rest.
 */
export function TriggerFilterChips({
  value,
  counts,
  onToggle,
  onClear,
}: {
  value: TriggerFilter;
  counts: TriggerStatusCounts;
  onToggle: (status: TriggerStatus) => void;
  onClear: () => void;
}): React.ReactNode {
  return (
    <fieldset
      className="flex flex-wrap gap-1.5 pb-2"
      data-testid="trigger-filter-chips"
    >
      <legend className="sr-only">Filter workflows by trigger state</legend>
      <FilterChip
        count={counts.all}
        onClick={onClear}
        selected={value.size === 0}
        value="all"
      >
        All
      </FilterChip>
      {FILTER_OPTIONS.map((option) => (
        <FilterChip
          count={counts[option.value]}
          key={option.value}
          onClick={() => onToggle(option.value)}
          selected={value.has(option.value)}
          value={option.value}
        >
          {option.label}
        </FilterChip>
      ))}
    </fieldset>
  );
}

export function WorkflowSearchField({
  value,
  onChange,
  ref,
}: {
  value: string;
  onChange: (value: string) => void;
  ref?: React.Ref<HTMLInputElement>;
}): React.ReactNode {
  return (
    <div className="pb-2">
      <SearchInput
        aria-label="Search workflows"
        data-testid="workflow-search"
        onValueChange={onChange}
        placeholder="Search workflows"
        ref={ref}
        value={value}
      />
    </div>
  );
}
