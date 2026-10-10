"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  TriggerFilterButton,
  TriggerFilters,
} from "@/components/workflow-trigger-status";
import { useDebounce } from "@/lib/hooks/use-debounce";
import type { NavPanelStates } from "@/lib/hooks/use-persisted-nav-state";
import { toggleInSet } from "@/lib/utils";
import {
  countDeactivated,
  countTriggerStatuses,
  countTriggerTypes,
  describeEmptyFilterResult,
  listedTriggerTypes,
  matchesTriggerFilter,
  matchesTriggerTypeFilter,
  type TriggerFilter,
  type TriggerTypeFilter,
} from "@/lib/workflow/trigger-display";
import type { WorkflowEntry } from "./workflow-picker-list";

/**
 * One panel's trigger filter: the Status and Trigger picks, and whether the
 * row of menus is shown. Each flyout panel that lists workflows keeps its own.
 */
export type PickerFilter = {
  status: TriggerFilter;
  types: TriggerTypeFilter;
  open: boolean;
  isFiltered: boolean;
  buttonRef: React.RefObject<HTMLButtonElement | null>;
  setStatus: React.Dispatch<React.SetStateAction<TriggerFilter>>;
  setTypes: React.Dispatch<React.SetStateAction<TriggerTypeFilter>>;
  // Drops both filters and hides the row.
  clear: () => void;
  // The filter button: with a filter on it clears the filters and hides the
  // row in one go, so the row never hides while it is shortening the list.
  toggle: () => void;
  // Drops both filters and keeps the row, for the empty result's link and
  // the row's ×.
  reset: () => void;
  // Escape on a menu button hides an unused row; it never throws away picks
  // (a second, habitual Escape after closing a menu would), so with a filter
  // on it does nothing and the × or the filter button clears them.
  escape: () => void;
  emptyText: string;
};

export function usePickerFilter(
  // The state of the panel the filter belongs to. Closing the panel any way
  // at all (Escape, clicking outside, the close button) drops the filter.
  panelState: NavPanelStates["projects"]
): PickerFilter {
  const [status, setStatus] = useState<TriggerFilter>(() => new Set());
  const [types, setTypes] = useState<TriggerTypeFilter>(() => new Set());
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const isFiltered = status.size > 0 || types.size > 0;

  const clear = useCallback((): void => {
    setStatus(new Set());
    setTypes(new Set());
    setOpen(false);
  }, []);

  useEffect(() => {
    if (panelState === "closed") {
      clear();
    }
  }, [panelState, clear]);

  return {
    status,
    types,
    open,
    isFiltered,
    buttonRef,
    setStatus,
    setTypes,
    clear,
    toggle: () => {
      if (open && isFiltered) {
        clear();
        return;
      }
      setOpen(!open);
    },
    reset: () => {
      setStatus(new Set());
      setTypes(new Set());
      buttonRef.current?.focus();
    },
    escape: () => {
      if (!isFiltered) {
        setOpen(false);
        buttonRef.current?.focus();
      }
    },
    emptyText: isFiltered ? describeEmptyFilterResult(status, types) : "",
  };
}

// The workflows both menus let through.
export function applyPickerFilter(
  workflows: WorkflowEntry[],
  filter: PickerFilter
): WorkflowEntry[] {
  if (!filter.isFiltered) {
    return workflows;
  }
  return workflows.filter(
    (w) =>
      matchesTriggerFilter(w, filter.status) &&
      matchesTriggerTypeFilter(w, filter.types)
  );
}

export function PickerFilterButton({
  filter,
  panelId,
  panelName,
  hasWorkflows,
  loading,
}: {
  filter: PickerFilter;
  // The id of the row this button shows and hides.
  panelId: string;
  // The panel's title, which tells this button from the other panel's.
  panelName: string;
  // Whether the panel's list has anything to filter.
  hasWorkflows: boolean;
  loading: boolean;
}): React.ReactNode {
  return (
    <TriggerFilterButton
      controls={panelId}
      // An open row keeps its button working even once the list empties, so
      // a leftover filter can always be cleared.
      disabled={loading || !(hasWorkflows || filter.open)}
      filtered={filter.isFiltered}
      onToggle={filter.toggle}
      open={filter.open}
      panelName={panelName}
      ref={filter.buttonRef}
    />
  );
}

// How long the result count must stay the same before it is announced.
const ANNOUNCE_DELAY_MS = 400;

// A polite live region that speaks only once the text has stopped changing
// for a moment, so a quick run of filter picks is announced once.
function DelayedAnnouncement({ text }: { text: string }): React.ReactNode {
  const announced = useDebounce(text, ANNOUNCE_DELAY_MS);
  return (
    <p aria-live="polite" className="sr-only">
      {announced}
    </p>
  );
}

/**
 * The row of filter menus, pinned to the top of the panel's scrolling list
 * so the sign that a filter is on stays in view on long lists.
 */
export function PickerFilterRow({
  filter,
  panelId,
  panelName,
  workflows,
  shownCount,
  loading,
}: {
  filter: PickerFilter;
  panelId: string;
  panelName: string;
  // Every workflow the filter applies to, before filtering.
  workflows: WorkflowEntry[];
  shownCount: number;
  loading: boolean;
}): React.ReactNode {
  return (
    <>
      {filter.open && !loading && (
        // The negative offsets cover the panel's p-2 padding.
        <div
          className="fade-in-0 slide-in-from-top-1 sticky -top-2 z-10 -mx-2 -mt-2 mb-1 animate-in border-b bg-background px-2 pt-2 duration-150 motion-reduce:animate-none"
          id={panelId}
        >
          <FilterMenus filter={filter} workflows={workflows} />
        </div>
      )}
      <DelayedAnnouncement
        text={
          filter.isFiltered
            ? `${shownCount} of ${workflows.length} workflows shown in ${panelName}`
            : ""
        }
      />
    </>
  );
}

// The counts are worked out only while the row is shown.
function FilterMenus({
  filter,
  workflows,
}: {
  filter: PickerFilter;
  workflows: WorkflowEntry[];
}): React.ReactNode {
  // Each menu counts the workflows the other menu lets through, so its
  // numbers say what picking an entry would show.
  const typeFiltered = workflows.filter((w) =>
    matchesTriggerTypeFilter(w, filter.types)
  );
  const statusMatches = workflows.filter((w) =>
    matchesTriggerFilter(w, filter.status)
  );
  return (
    <TriggerFilters
      deactivatedCount={countDeactivated(typeFiltered)}
      listedTypes={listedTriggerTypes(workflows, filter.types)}
      onClearAll={filter.reset}
      onClearStatus={() => filter.setStatus(new Set())}
      onClearTypes={() => filter.setTypes(new Set())}
      onEscape={filter.escape}
      onToggleStatus={(status) =>
        filter.setStatus((current) => toggleInSet(current, status))
      }
      onToggleType={(type) =>
        filter.setTypes((current) => toggleInSet(current, type))
      }
      status={filter.status}
      statusCounts={countTriggerStatuses(typeFiltered)}
      typeCounts={countTriggerTypes(statusMatches)}
      types={filter.types}
    />
  );
}
