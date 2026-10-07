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
  isActive = false,
}: {
  triggerType: WorkflowTriggerType | undefined;
  status: TriggerStatus;
  // Defaults to the bare type, e.g. "Block trigger".
  tooltip?: string;
  // On the highlighted row a grey icon steps up, as the dimmed text does;
  // on hover it follows the row's `group` class.
  isActive?: boolean;
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
              : cn(
                  "border-foreground/15",
                  isActive
                    ? "text-foreground/55"
                    : "text-muted-foreground group-hover:text-foreground/55"
                )
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

// Runs onEscape for an Escape nothing else used yet, and marks it used so
// the sidebar does not also close the panel.
function handleEscape(
  event: React.KeyboardEvent,
  onEscape: (() => void) | undefined
): void {
  if (onEscape && event.key === "Escape" && !event.defaultPrevented) {
    event.preventDefault();
    onEscape();
  }
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
  // The name stays fixed; aria-expanded says whether it is open. Only the
  // tooltip changes wording.
  return (
    <Tooltip delayDuration={TOOLTIP_DELAY_MS}>
      <TooltipTrigger asChild>
        <button
          aria-controls={open ? TRIGGER_FILTER_PANEL_ID : undefined}
          aria-expanded={open}
          aria-label="Filter and search"
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
      <TooltipContent side="bottom">
        {open ? "Hide filter and search" : "Filter and search"}
      </TooltipContent>
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
  onEscape,
  hint,
  children,
}: {
  selected: boolean;
  count: number;
  value: string;
  onClick: () => void;
  onEscape?: () => void;
  // Extra context, shown on hover and read by screen readers.
  hint?: string;
  children: React.ReactNode;
}): React.ReactNode {
  const chip = (
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
      onKeyDown={(event) => handleEscape(event, onEscape)}
      type="button"
    >
      {/* The check's space is always kept, so picking a chip never makes it
          wider and re-wraps the row. */}
      <Check
        aria-hidden="true"
        className={cn("size-3", !selected && "invisible")}
      />
      {children} <span className="tabular-nums">{count}</span>
      {hint && <span className="sr-only">, {hint}</span>}
    </button>
  );
  if (!hint) {
    return chip;
  }
  return (
    <Tooltip delayDuration={TOOLTIP_DELAY_MS}>
      <TooltipTrigger asChild>{chip}</TooltipTrigger>
      <TooltipContent side="bottom">{hint}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Status chips that combine: Enabled and Disabled together show both. All
 * is selected while nothing else is, and clicking it clears the rest.
 */
export function TriggerFilterChips({
  value,
  counts,
  deactivatedCount = 0,
  onToggle,
  onClear,
  onEscape,
}: {
  value: TriggerFilter;
  counts: TriggerStatusCounts;
  // Ops-deactivated workflows count as Disabled; the chip says so.
  deactivatedCount?: number;
  onToggle: (status: TriggerStatus) => void;
  onClear: () => void;
  // Escape on a chip closes the filter rather than the surrounding panel.
  onEscape?: () => void;
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
        onEscape={onEscape}
        selected={value.size === 0}
        value="all"
      >
        All
      </FilterChip>
      {FILTER_OPTIONS.map((option) => (
        <FilterChip
          count={counts[option.value]}
          hint={
            option.value === "disabled" && deactivatedCount > 0
              ? `Includes ${deactivatedCount} deactivated by KeeperHub`
              : undefined
          }
          key={option.value}
          onClick={() => onToggle(option.value)}
          onEscape={onEscape}
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
  onEscape,
  ref,
}: {
  value: string;
  onChange: (value: string) => void;
  // Escape on an empty field; a typed query is cleared first by SearchInput.
  onEscape?: () => void;
  ref?: React.Ref<HTMLInputElement>;
}): React.ReactNode {
  return (
    <div className="pb-2">
      <SearchInput
        aria-label="Search workflows"
        data-testid="workflow-search"
        onKeyDown={(event) => handleEscape(event, onEscape)}
        onValueChange={onChange}
        placeholder="Search workflows"
        ref={ref}
        value={value}
      />
    </div>
  );
}
