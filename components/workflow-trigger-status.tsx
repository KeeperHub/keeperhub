"use client";

// The menu entries use Radix's CheckboxItem directly: the shared
// DropdownMenuCheckboxItem draws a bare check mark in a fixed left gutter,
// and these entries need a visible box, an icon and a count instead.
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
  TRIGGER_STATUS_OPTIONS,
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
function TriggerTile({
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
  // list always shows why: a click clears the filters and only then hides it.
  filtered?: boolean;
}): React.ReactNode {
  let tip = "Filter";
  if (open && filtered) {
    tip = "Clear filters and hide";
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
          aria-expanded={open}
          aria-label={filtered ? "Filter, filters on" : "Filter"}
          className={cn(
            "relative size-6 shrink-0 rounded-md border p-1 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-foreground/60 disabled:pointer-events-none disabled:opacity-40",
            open
              ? "border-foreground/40 bg-foreground/10 text-foreground"
              : "border-transparent text-muted-foreground hover:bg-muted hover:text-foreground"
          )}
          data-filtered={filtered || undefined}
          data-testid="trigger-filter-button"
          disabled={disabled}
          onClick={onToggle}
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

// A menu opens after the pointer rests on its button this long, so moving
// past it on the way to the list below opens nothing ...
export const MENU_HOVER_OPEN_MS = 250;
// ... and closes this long after the pointer leaves both button and menu,
// so crossing the gap between them does not close it.
export const MENU_HOVER_CLOSE_MS = 300;

type MenuKey = "status" | "trigger";

type MenuBinding = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: {
    ref: (element: HTMLButtonElement | null) => void;
    onPointerEnter: (event: React.PointerEvent) => void;
    onPointerLeave: (event: React.PointerEvent) => void;
    onPointerDown: (event: React.PointerEvent) => void;
    onKeyDown: (event: React.KeyboardEvent) => void;
  };
  content: {
    ref: (element: HTMLDivElement | null) => void;
    onPointerEnter: () => void;
    onPointerLeave: (event: React.PointerEvent) => void;
    onOpenAutoFocus: (event: Event) => void;
    onCloseAutoFocus: (event: Event) => void;
    onEscapeKeyDown: (event: KeyboardEvent) => void;
  };
};

/**
 * The open state of the row's menus, one at a time like a menu bar, with
 * open-on-hover on top of the usual click and keyboard opening (touch and
 * keyboard users never hover).
 *
 * A menu opened by hover leaves focus where it was, and gives it back there
 * when it closes, even after the pointer has moved focus onto its items. It
 * closes when the pointer leaves; clicking its button, or pressing the
 * down arrow on it, keeps it open as if it had been opened that way. While
 * one menu is open, resting on the other button switches straight to it.
 */
function useFilterMenus(): (key: MenuKey) => MenuBinding {
  const [openMenu, setOpenMenu] = useState<MenuKey | null>(null);
  const openedByHover = useRef(false);
  const focusBefore = useRef<HTMLElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const triggers = useRef<Partial<Record<MenuKey, HTMLButtonElement>>>({});
  const contents = useRef<Partial<Record<MenuKey, HTMLDivElement>>>({});
  useEffect(() => () => clearTimeout(timer.current), []);

  const later = (ms: number, action: () => void): void => {
    clearTimeout(timer.current);
    timer.current = setTimeout(action, ms);
  };
  const close = (key: MenuKey): void =>
    setOpenMenu((current) => (current === key ? null : current));
  const closeIfHovered = (key: MenuKey, event: React.PointerEvent): void => {
    if (event.pointerType === "mouse" && openedByHover.current) {
      later(MENU_HOVER_CLOSE_MS, () => close(key));
    }
  };

  return (key) => ({
    open: openMenu === key,
    onOpenChange: (next) => {
      clearTimeout(timer.current);
      if (next) {
        openedByHover.current = false;
        setOpenMenu(key);
      } else {
        close(key);
      }
    },
    trigger: {
      ref: (element) => {
        triggers.current[key] = element ?? undefined;
      },
      onPointerEnter: (event) => {
        if (event.pointerType !== "mouse") {
          return;
        }
        if (openMenu === key) {
          clearTimeout(timer.current);
          return;
        }
        if (openMenu !== null) {
          clearTimeout(timer.current);
          setOpenMenu(key);
          return;
        }
        later(MENU_HOVER_OPEN_MS, () => {
          openedByHover.current = true;
          focusBefore.current =
            document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null;
          setOpenMenu(key);
        });
      },
      onPointerLeave: (event) => {
        if (openMenu === key) {
          closeIfHovered(key, event);
        } else if (openMenu === null) {
          clearTimeout(timer.current);
        }
      },
      onPointerDown: (event) => {
        // The menu toggles on a primary-button press; one opened by hover
        // stays open and now behaves as if it had been clicked open.
        if (event.button === 0 && openMenu === key && openedByHover.current) {
          event.preventDefault();
          openedByHover.current = false;
          clearTimeout(timer.current);
        }
      },
      onKeyDown: (event) => {
        if (
          event.key === "ArrowDown" &&
          openMenu === key &&
          openedByHover.current
        ) {
          event.preventDefault();
          openedByHover.current = false;
          clearTimeout(timer.current);
          contents.current[key]
            ?.querySelector<HTMLElement>("[role=menuitemcheckbox]")
            ?.focus();
        }
      },
    },
    content: {
      ref: (element) => {
        contents.current[key] = element ?? undefined;
      },
      onPointerEnter: () => clearTimeout(timer.current),
      onPointerLeave: (event) => closeIfHovered(key, event),
      onOpenAutoFocus: (event) => {
        if (openedByHover.current) {
          event.preventDefault();
        }
      },
      onCloseAutoFocus: (event) => {
        if (!openedByHover.current) {
          return;
        }
        event.preventDefault();
        const active = document.activeElement;
        const lost =
          !active ||
          active === document.body ||
          contents.current[key]?.contains(active);
        if (lost) {
          const back = focusBefore.current?.isConnected
            ? focusBefore.current
            : triggers.current[key];
          back?.focus();
        }
      },
      // The menu's own Escape: it closes the menu and nothing else, wherever
      // focus is (a hover-opened menu may not hold it).
      onEscapeKeyDown: (event) => markEscapeHandled(event),
    },
  });
}

type FilterMenuOption<T extends string> = {
  value: T;
  label: string;
  count: number;
  // Drawn before the label, e.g. the trigger tile.
  icon?: React.ReactNode;
  // A second line under the label.
  hint?: React.ReactNode;
};

/**
 * One filter as a dropdown of checkboxes with counts. Picks add up; none
 * picked means All. The button names what is picked: "Status All" while
 * nothing is, then the first pick (with its icon) and "+N" for the rest.
 */
function FilterMenu<T extends string>({
  label,
  options,
  value,
  onToggle,
  onClear,
  onEscape,
  binding,
  boundary,
  align = "start",
  testId,
}: {
  label: string;
  options: readonly FilterMenuOption<T>[];
  value: ReadonlySet<T>;
  onToggle: (value: T) => void;
  onClear: () => void;
  // Escape on the button, with the menu shut.
  onEscape?: () => void;
  binding: MenuBinding;
  // The panel: the menu shifts to stay inside it.
  boundary?: Element | null;
  // Which edge of the button the menu lines up with.
  align?: "start" | "end";
  testId?: string;
}): React.ReactNode {
  const picked = options.filter((option) => value.has(option.value));
  const first = picked[0];
  const accessibleValue =
    picked.length === 0
      ? "All"
      : picked.map((option) => option.label).join(", ");
  return (
    <DropdownMenu
      modal={false}
      onOpenChange={binding.onOpenChange}
      open={binding.open}
    >
      <DropdownMenuTrigger asChild>
        <button
          aria-label={`${label}: ${accessibleValue}`}
          className={cn(
            "flex h-7 min-w-0 items-center gap-1.5 rounded-md border px-2.5 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-foreground/60",
            first || binding.open
              ? "border-foreground/40 bg-foreground/10 text-foreground"
              : "border-border text-muted-foreground hover:bg-muted/50 hover:text-foreground"
          )}
          data-testid={testId}
          type="button"
          {...binding.trigger}
          onKeyDown={(event) => {
            binding.trigger.onKeyDown(event);
            handleEscape(event, onEscape);
          }}
        >
          {first ? (
            <>
              {first.icon}
              <span className="truncate font-medium">{first.label}</span>
              {picked.length > 1 && (
                <span className="text-foreground/70 tabular-nums">
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
        collisionBoundary={boundary ?? undefined}
        collisionPadding={8}
        data-filter-menu={label.toLowerCase()}
        {...binding.content}
      >
        {options.map((option) => {
          const checked = value.has(option.value);
          // An entry that would empty the list is dimmed, but not its count:
          // the zero is the point.
          const dim = option.count === 0 && !checked && "opacity-60";
          return (
            <CheckboxItem
              checked={checked}
              className="flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden focus:bg-accent focus:text-accent-foreground"
              data-filter={option.value}
              key={option.value}
              onCheckedChange={() => onToggle(option.value)}
              // Stays open, so several can be picked in one go.
              onSelect={(event) => event.preventDefault()}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "flex size-3.5 shrink-0 items-center justify-center rounded-xs border",
                  checked
                    ? "border-foreground/60 bg-foreground/15"
                    : "border-border"
                )}
              >
                <ItemIndicator>
                  <Check className="size-3" />
                </ItemIndicator>
              </span>
              <span className={cn("flex min-w-0 items-center gap-2", dim)}>
                {option.icon}
                <span className="flex min-w-0 flex-col">
                  <span>{option.label}</span>
                  {option.hint}
                </span>
              </span>
              <span className="ml-auto text-foreground/70 text-xs tabular-nums">
                {option.count}
              </span>
            </CheckboxItem>
          );
        })}
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
  // Escape on a menu button with its menu shut.
  onEscape?: () => void;
}): React.ReactNode {
  const menus = useFilterMenus();
  const [row, setRow] = useState<HTMLDivElement | null>(null);
  // The panel the row sits in, which neither menu may cross.
  const boundary = row?.closest("[data-flyout]") ?? null;
  return (
    <div
      className="flex items-center gap-1.5 pb-2"
      data-testid="trigger-filters"
      ref={setRow}
    >
      <FilterMenu
        binding={menus("status")}
        boundary={boundary}
        label="Status"
        onClear={onClearStatus}
        onEscape={onEscape}
        onToggle={onToggleStatus}
        options={TRIGGER_STATUS_OPTIONS.map((option) => ({
          ...option,
          count: statusCounts[option.value],
          hint:
            option.value === "disabled" && deactivatedCount > 0 ? (
              <span className="text-status-deactivated text-xs">
                Incl. {deactivatedCount} deactivated
              </span>
            ) : undefined,
        }))}
        testId="status-filter"
        value={status}
      />
      <FilterMenu
        align="end"
        binding={menus("trigger")}
        boundary={boundary}
        label="Trigger"
        onClear={onClearTypes}
        onEscape={onEscape}
        onToggle={onToggleType}
        options={listedTypes.map((type) => ({
          value: type,
          label: type,
          count: typeCounts[type],
          icon: (
            <TriggerTile
              className="size-4 rounded-xs [&_svg]:size-2.5"
              status="manual"
              triggerType={type}
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
