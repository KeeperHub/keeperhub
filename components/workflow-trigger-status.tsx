"use client";

import { CheckboxItem, ItemIndicator } from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown, ListFilter, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { getTriggerIcon } from "@/components/workflow-trigger-icons";
import { isEscapeHandled, markEscapeHandled } from "@/lib/escape-key";
import { cn } from "@/lib/utils";
import type { WorkflowTriggerType } from "@/lib/workflow/store";
import {
  getTriggerTypeLabel,
  type TriggerFilter,
  type TriggerStatus,
  type TriggerStatusCounts,
  type TriggerTypeFilter,
} from "@/lib/workflow/trigger-display";

// Tooltips here wait this long, so a pointer moving down the list does not
// open one on every row it passes.
export const TOOLTIP_DELAY_MS = 400;

/**
 * The trigger-type tile: the icon on a 20px tile, green only when the
 * workflow fires on its own. The filter menu draws the same tile, always
 * grey, so a menu entry looks exactly like the rows it shows.
 */
export function TriggerTile({
  triggerType,
  status,
  isActive = false,
  className,
  ...props
}: {
  triggerType: WorkflowTriggerType | undefined;
  status: TriggerStatus;
  // On the highlighted row a grey icon steps up, as the dimmed text does;
  // on hover it follows the row's `group` class.
  isActive?: boolean;
} & React.ComponentProps<"span">): React.ReactNode {
  const Icon = getTriggerIcon(triggerType);
  return (
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
            ),
        className
      )}
      {...props}
    >
      <Icon aria-hidden="true" className="size-3" />
    </span>
  );
}

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
  focusOpen = false,
  focusLines = [],
}: {
  triggerType: WorkflowTriggerType | undefined;
  status: TriggerStatus;
  // Defaults to the bare type, e.g. "Block trigger".
  tooltip?: string;
  isActive?: boolean;
  // Set by the row while it has keyboard focus and has something worth
  // showing: the tooltip opens with focusLines (a cut-off name, why a
  // workflow is deactivated) above what mouse users get on hover.
  focusOpen?: boolean;
  focusLines?: string[];
}): React.ReactNode {
  const [hoverOpen, setHoverOpen] = useState(false);
  return (
    <Tooltip
      delayDuration={TOOLTIP_DELAY_MS}
      onOpenChange={setHoverOpen}
      open={hoverOpen || focusOpen}
    >
      <TooltipTrigger asChild>
        <TriggerTile
          data-testid="trigger-status-icon"
          data-trigger-status={status}
          data-trigger-type={triggerType ?? "Manual"}
          isActive={isActive}
          status={status}
          triggerType={triggerType}
        />
      </TooltipTrigger>
      <TooltipContent className="pointer-events-none" side="top">
        {focusOpen &&
          focusLines.map((line, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed lines that never reorder; the text alone may repeat
            <div key={index}>{line}</div>
          ))}
        <div>{tooltip ?? getTriggerTypeLabel(triggerType)}</div>
      </TooltipContent>
    </Tooltip>
  );
}

// Runs onEscape for an Escape no other control used yet, and marks it used
// so the sidebar does not also close the panel.
function handleEscape(
  event: React.KeyboardEvent,
  onEscape: (() => void) | undefined
): void {
  if (
    onEscape &&
    event.key === "Escape" &&
    !isEscapeHandled(event.nativeEvent)
  ) {
    markEscapeHandled(event.nativeEvent);
    onEscape();
  }
}

// The row of filter menus that the filter button shows and hides.
export const TRIGGER_FILTER_PANEL_ID = "workflow-trigger-filter";

export function TriggerFilterButton({
  open,
  onToggle,
  ref,
  disabled = false,
  filtered = false,
}: {
  open: boolean;
  onToggle: () => void;
  ref?: React.Ref<HTMLButtonElement>;
  // While the workflows load there is nothing to filter yet.
  disabled?: boolean;
  // A filter is on. The row of menus then stays in view, so the shortened
  // list always shows why; the button says how to hide it.
  filtered?: boolean;
}): React.ReactNode {
  const locked = open && filtered;
  let tip = "Filter";
  if (locked) {
    tip = "Clear the filters to hide them";
  } else if (open) {
    tip = "Hide filters";
  }
  // The name stays fixed; aria-expanded says whether it is open. Only the
  // tooltip changes wording.
  return (
    <Tooltip delayDuration={TOOLTIP_DELAY_MS}>
      <TooltipTrigger asChild>
        <button
          aria-controls={open ? TRIGGER_FILTER_PANEL_ID : undefined}
          aria-disabled={locked || undefined}
          aria-expanded={open}
          aria-label={filtered ? "Filter, filters on" : "Filter"}
          className={cn(
            "relative size-6 shrink-0 rounded-md border p-1 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-foreground/60 disabled:pointer-events-none disabled:opacity-40",
            open
              ? "border-foreground/40 bg-foreground/10 text-foreground"
              : "border-transparent text-muted-foreground hover:bg-muted hover:text-foreground",
            locked && "cursor-default"
          )}
          data-filtered={filtered || undefined}
          data-testid="trigger-filter-button"
          disabled={disabled}
          onClick={locked ? undefined : onToggle}
          ref={ref}
          type="button"
        >
          <ListFilter className="size-4" />
          {filtered && (
            <span
              aria-hidden="true"
              className="absolute -top-1 -right-1 size-2 rounded-full border-2 border-background bg-foreground"
            />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{tip}</TooltipContent>
    </Tooltip>
  );
}

// A menu opens after the pointer rests on its button this long, so sweeping
// past it on the way to the list opens nothing ...
export const MENU_HOVER_OPEN_MS = 150;
// ... and closes this long after the pointer leaves both button and menu,
// so crossing the gap between them does not close it.
export const MENU_HOVER_CLOSE_MS = 300;

/**
 * Open-on-hover for a dropdown menu, on top of the usual click and keyboard
 * opening (touch and keyboard users never hover). A menu opened by hover
 * leaves focus where it was and closes when the pointer leaves; a click on
 * its button while it is open keeps it open, as if it had been clicked open.
 */
function useHoverMenu(): {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: {
    onPointerEnter: (event: React.PointerEvent) => void;
    onPointerLeave: (event: React.PointerEvent) => void;
    onPointerDown: (event: React.PointerEvent) => void;
  };
  content: {
    onPointerEnter: () => void;
    onPointerLeave: (event: React.PointerEvent) => void;
    onOpenAutoFocus: (event: Event) => void;
    onCloseAutoFocus: (event: Event) => void;
  };
} {
  const [open, setOpen] = useState(false);
  const openedByHover = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const later = (ms: number, action: () => void): void => {
    clearTimeout(timer.current);
    timer.current = setTimeout(action, ms);
  };
  const closeIfHovered = (event: React.PointerEvent): void => {
    if (event.pointerType === "mouse" && openedByHover.current) {
      later(MENU_HOVER_CLOSE_MS, () => setOpen(false));
    }
  };
  return {
    open,
    onOpenChange: (next) => {
      clearTimeout(timer.current);
      if (next) {
        openedByHover.current = false;
      }
      setOpen(next);
    },
    trigger: {
      onPointerEnter: (event) => {
        if (event.pointerType !== "mouse") {
          return;
        }
        if (open) {
          clearTimeout(timer.current);
          return;
        }
        later(MENU_HOVER_OPEN_MS, () => {
          openedByHover.current = true;
          setOpen(true);
        });
      },
      onPointerLeave: (event) => {
        if (open) {
          closeIfHovered(event);
        } else {
          clearTimeout(timer.current);
        }
      },
      onPointerDown: (event) => {
        // The menu toggles on pointer down; one opened by hover stays open
        // and now behaves as if it had been clicked open.
        if (open && openedByHover.current) {
          event.preventDefault();
          openedByHover.current = false;
          clearTimeout(timer.current);
        }
      },
    },
    content: {
      onPointerEnter: () => clearTimeout(timer.current),
      onPointerLeave: closeIfHovered,
      onOpenAutoFocus: (event) => {
        if (openedByHover.current) {
          event.preventDefault();
        }
      },
      onCloseAutoFocus: (event) => {
        if (openedByHover.current) {
          event.preventDefault();
        }
      },
    },
  };
}

export type FilterMenuOption<T extends string> = {
  value: T;
  label: string;
  count: number;
  // Drawn before the label, e.g. the trigger tile.
  icon?: React.ReactNode;
  // A second line under the label.
  hint?: string;
};

/**
 * One filter as a dropdown of checkboxes with counts. Picks add up; none
 * picked means All. The button names what is picked: "Status All" while
 * nothing is, then the first pick (with its icon) and "+N" for the rest.
 */
export function FilterMenu<T extends string>({
  label,
  options,
  value,
  onToggle,
  onClear,
  onEscape,
  align = "start",
  testId,
}: {
  label: string;
  options: readonly FilterMenuOption<T>[];
  value: ReadonlySet<T>;
  onToggle: (value: T) => void;
  onClear: () => void;
  // Escape on the button, with the menu shut: steps the filter back.
  onEscape?: () => void;
  // Which edge of the button the menu lines up with; the panel's right-hand
  // menu aligns to its end so it never crosses the panel's edge.
  align?: "start" | "end";
  testId?: string;
}): React.ReactNode {
  const menu = useHoverMenu();
  const picked = options.filter((option) => value.has(option.value));
  const first = picked[0];
  const accessibleValue =
    picked.length === 0
      ? "All"
      : picked.map((option) => option.label).join(", ");
  return (
    <DropdownMenu
      modal={false}
      onOpenChange={menu.onOpenChange}
      open={menu.open}
    >
      <DropdownMenuTrigger asChild>
        <button
          aria-label={`${label}: ${accessibleValue}`}
          className={cn(
            "flex h-7 min-w-0 items-center gap-1.5 rounded-md border px-2.5 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-foreground/60",
            first || menu.open
              ? "border-foreground/40 bg-foreground/10 text-foreground"
              : "border-border text-muted-foreground hover:bg-muted/50 hover:text-foreground"
          )}
          data-testid={testId}
          onKeyDown={(event) => handleEscape(event, onEscape)}
          type="button"
          {...menu.trigger}
        >
          {first ? (
            <>
              {first.icon}
              <span className="truncate font-medium">{first.label}</span>
              {picked.length > 1 && (
                <span className="text-muted-foreground tabular-nums">
                  +{picked.length - 1}
                </span>
              )}
            </>
          ) : (
            <>
              <span>{label}</span>
              <span className="text-foreground">All</span>
            </>
          )}
          <ChevronDown aria-hidden="true" className="size-3 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align={align}
        className="w-52"
        collisionPadding={8}
        {...menu.content}
      >
        {options.map((option) => (
          <CheckboxItem
            checked={value.has(option.value)}
            className={cn(
              "flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden focus:bg-accent focus:text-accent-foreground",
              option.count === 0 && !value.has(option.value) && "opacity-60"
            )}
            data-filter={option.value}
            key={option.value}
            onCheckedChange={() => onToggle(option.value)}
            // Stays open, so several can be picked in one go.
            onSelect={(event) => event.preventDefault()}
          >
            <span
              aria-hidden="true"
              className={cn(
                "flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border",
                value.has(option.value)
                  ? "border-foreground/60 bg-foreground/15"
                  : "border-border"
              )}
            >
              <ItemIndicator>
                <Check className="size-3" />
              </ItemIndicator>
            </span>
            {option.icon}
            <span className="flex min-w-0 flex-col">
              <span>{option.label}</span>
              {option.hint && (
                <span className="text-muted-foreground text-xs">
                  {option.hint}
                </span>
              )}
            </span>
            <span className="ml-auto text-muted-foreground text-xs tabular-nums">
              {option.count}
            </span>
          </CheckboxItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="text-xs"
          disabled={value.size === 0}
          onSelect={onClear}
        >
          Clear {label.toLowerCase()} filter
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const STATUS_OPTIONS: ReadonlyArray<{ value: TriggerStatus; label: string }> = [
  { value: "enabled", label: "Enabled" },
  { value: "disabled", label: "Disabled" },
  { value: "manual", label: "Manual" },
];

/**
 * The filter row: a Status menu and a Trigger menu, combined (within a menu
 * picks add up, across the two they narrow), and a button clearing both.
 * Each menu's counts are for the workflows the other menu lets through.
 */
export function TriggerFilters({
  status,
  types,
  statusCounts,
  typeCounts,
  listedTypes,
  deactivatedCount = 0,
  onToggleStatus,
  onToggleType,
  onClearStatus,
  onClearTypes,
  onClearAll,
  onEscape,
}: {
  status: TriggerFilter;
  types: TriggerTypeFilter;
  statusCounts: TriggerStatusCounts;
  typeCounts: Record<WorkflowTriggerType, number>;
  // The trigger types the menu offers, in order.
  listedTypes: readonly WorkflowTriggerType[];
  // Ops-deactivated workflows count as Disabled; the entry says so.
  deactivatedCount?: number;
  onToggleStatus: (status: TriggerStatus) => void;
  onToggleType: (type: WorkflowTriggerType) => void;
  onClearStatus: () => void;
  onClearTypes: () => void;
  onClearAll: () => void;
  onEscape?: () => void;
}): React.ReactNode {
  const typeOptions = listedTypes.map((type) => ({
    value: type,
    label: type,
    count: typeCounts[type],
  }));
  return (
    <div
      className="flex items-center gap-1.5 pb-2"
      data-testid="trigger-filters"
    >
      <FilterMenu
        label="Status"
        onClear={onClearStatus}
        onEscape={onEscape}
        onToggle={onToggleStatus}
        options={STATUS_OPTIONS.map((option) => ({
          ...option,
          count: statusCounts[option.value],
          hint:
            option.value === "disabled" && deactivatedCount > 0
              ? `Includes ${deactivatedCount} deactivated by KeeperHub`
              : undefined,
        }))}
        testId="status-filter"
        value={status}
      />
      <FilterMenu
        align="end"
        label="Trigger"
        onClear={onClearTypes}
        onEscape={onEscape}
        onToggle={onToggleType}
        options={typeOptions.map((option) => ({
          ...option,
          icon: (
            <TriggerTile
              className="size-4 rounded-[4px] [&_svg]:size-2.5"
              status="manual"
              triggerType={option.value}
            />
          ),
        }))}
        testId="trigger-type-filter"
        value={types}
      />
      {(status.size > 0 || types.size > 0) && (
        <Tooltip delayDuration={TOOLTIP_DELAY_MS}>
          <TooltipTrigger asChild>
            <button
              aria-label="Clear filters"
              className="ml-auto flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-foreground/60"
              data-testid="trigger-filter-clear"
              onClick={onClearAll}
              type="button"
            >
              <X aria-hidden="true" className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Clear filters</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
