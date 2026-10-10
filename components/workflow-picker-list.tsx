"use client";

import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { memo, useEffect, useRef, useState } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { TruncatedTooltip } from "@/components/ui/truncated-tooltip";
import {
  TOOLTIP_DELAY_MS,
  TriggerStatusIcon,
} from "@/components/workflow-trigger-status";
import type { Tag } from "@/lib/api-client";
import { isEscapeHandled, markEscapeHandled } from "@/lib/escape-key";
import { cn, toggleInSet } from "@/lib/utils";
import type { WorkflowTriggerType } from "@/lib/workflow/store";
import {
  describeDeactivation,
  getTriggerAccessibleStatus,
  getTriggerLabel,
  getTriggerStatus,
  getTriggerTooltip,
} from "@/lib/workflow/trigger-display";

// The rows of the sidebar's workflow picker and the tag groups they sit in.

export type WorkflowEntry = {
  id: string;
  name: string;
  updatedAt: string;
  projectId?: string | null;
  tagId?: string | null;
  // Soft-delete timestamp. The list route already excludes these rows;
  // filterPickerVisible() re-checks it so a stale cached payload cannot put
  // one back in the picker.
  deletedAt?: string | null;
  // The trigger type picks the row icon and decides whether the enabled
  // flag means anything -- see getTriggerStatus. Derived once at the
  // SavedWorkflow boundary so WorkflowItem doesn't have to carry the full
  // nodes payload.
  triggerType?: WorkflowTriggerType;
  // The trigger node's config, for the cadence label ("5 min", "Lift").
  triggerConfig?: Record<string, unknown>;
  // When false on a trigger that supports the enable switch, the picker
  // greys the icon and dims the name and label. The row stays selectable.
  enabled?: boolean;
  // Set by ops via admin API. The row's label says "Deactivated" in place of
  // the cadence; the user cannot clear this themselves.
  deactivatedAt?: string | null;
};

// Muted grey is too faint on the active or hovered row's bg-muted, so
// dimmed text steps up there.
function dimmedTextClass(isActive: boolean): string {
  return isActive
    ? "text-foreground/55"
    : "text-muted-foreground group-hover:text-foreground/55";
}

function labelColorClass(
  workflow: WorkflowEntry,
  status: ReturnType<typeof getTriggerStatus>,
  isActive: boolean
): string {
  if (workflow.deactivatedAt) {
    return "text-status-deactivated";
  }
  return status === "disabled"
    ? dimmedTextClass(isActive)
    : "text-foreground/75";
}

// While a row has keyboard focus, its icon tooltip opens with what the row
// cannot show: the name when it is cut off, why it is deactivated. After the
// same delay as hover, and only then, so tabbing down the list does not flash
// a tooltip on every row. Escape, or moving the mouse, puts it away.
function useFocusTooltip(hasSomethingToShow: boolean): {
  open: boolean;
  onFocus: (event: React.FocusEvent<HTMLElement>) => void;
  onBlur: () => void;
  onKeyDown: (event: React.KeyboardEvent) => void;
} {
  const [shown, setShown] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const open = shown && hasSomethingToShow;
  useEffect(() => () => clearTimeout(timer.current), []);
  // A pointer user hovering elsewhere would otherwise see two tooltips.
  useEffect(() => {
    if (!open) {
      return;
    }
    const hide = (): void => setShown(false);
    document.addEventListener("pointermove", hide, { once: true });
    return () => document.removeEventListener("pointermove", hide);
  }, [open]);
  return {
    open,
    onFocus: (event) => {
      clearTimeout(timer.current);
      if (event.currentTarget.matches(":focus-visible")) {
        timer.current = setTimeout(() => setShown(true), TOOLTIP_DELAY_MS);
      }
    },
    onBlur: () => {
      clearTimeout(timer.current);
      setShown(false);
    },
    onKeyDown: (event) => {
      if (
        open &&
        event.key === "Escape" &&
        !isEscapeHandled(event.nativeEvent)
      ) {
        markEscapeHandled(event.nativeEvent);
        setShown(false);
      }
    },
  };
}

// Memoized: the sidebar re-renders on every drag-resize step, and a row's
// labels parse its cron. Each fetch maps every workflow to a new entry and so
// re-renders every row; the memo skips the re-renders that come without a
// fetch, such as drag-resize.
export const WorkflowItem = memo(function WorkflowItem({
  workflow,
  activeWorkflowId,
}: {
  workflow: WorkflowEntry;
  activeWorkflowId: string | undefined;
}): React.ReactNode {
  const router = useRouter();
  const status = getTriggerStatus(workflow);
  const isActive = workflow.id === activeWorkflowId;
  const [nameTruncated, setNameTruncated] = useState(false);
  const focusLines = [
    ...(nameTruncated ? [workflow.name] : []),
    ...(workflow.deactivatedAt
      ? [describeDeactivation(workflow.deactivatedAt)]
      : []),
  ];
  const focusTooltip = useFocusTooltip(focusLines.length > 0);
  return (
    <button
      aria-current={isActive ? "page" : undefined}
      className={cn(
        "group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted outline-none focus-visible:ring-2 focus-visible:ring-foreground/60 focus-visible:ring-inset",
        isActive && "bg-muted"
      )}
      data-testid="workflow-picker-item"
      onBlur={focusTooltip.onBlur}
      onClick={() => router.push(`/workflows/${workflow.id}`)}
      onFocus={focusTooltip.onFocus}
      onKeyDown={focusTooltip.onKeyDown}
      type="button"
    >
      <TriggerStatusIcon
        focusLines={focusLines}
        focusOpen={focusTooltip.open}
        isActive={isActive}
        status={status}
        tooltip={getTriggerTooltip(workflow)}
        triggerType={workflow.triggerType}
      />
      <TruncatedTooltip
        className={cn(
          "min-w-0 flex-1",
          status === "disabled" && dimmedTextClass(isActive)
        )}
        delayDuration={TOOLTIP_DELAY_MS}
        onTruncatedChange={setNameTruncated}
        side="top"
        text={workflow.name}
      />
      {/* How or when it fires ("5 min", the event, "10 blocks"), on every
          row whether enabled or not; empty when the icon says it all. Fixed
          width (fits "Deactivated") so every name gets the same room; a long
          event name is cut off, with the full text on hover. Muted like the
          name when the workflow is off; Deactivated (ops switched it off,
          the user cannot undo it) is the one status word, in a muted amber
          with a tooltip saying who to ask. */}
      {/* Hidden from screen readers: the sr-only text below says the same
          and more, so nothing is read twice. */}
      <span
        aria-hidden="true"
        className={cn(
          "w-16 shrink-0 text-right text-xs",
          labelColorClass(workflow, status, isActive)
        )}
        data-testid="workflow-trigger-label"
      >
        {workflow.deactivatedAt ? (
          <Tooltip delayDuration={TOOLTIP_DELAY_MS}>
            <TooltipTrigger asChild>
              <span className="block truncate">Deactivated</span>
            </TooltipTrigger>
            <TooltipContent side="right">
              {describeDeactivation(workflow.deactivatedAt)}
            </TooltipContent>
          </Tooltip>
        ) : (
          <TruncatedTooltip
            className="block"
            delayDuration={TOOLTIP_DELAY_MS}
            side="right"
            text={getTriggerLabel(workflow)}
          />
        )}
      </span>
      <span className="sr-only">, {getTriggerAccessibleStatus(workflow)}</span>
    </button>
  );
});

const UNTAGGED_KEY = "__untagged__";

// The chevron of a tag group header, in a 20px slot so it lines up with the
// row icons. Hidden while filtering, when every group is held open and the
// header cannot fold.
function GroupChevron({
  collapsed,
  hidden,
}: {
  collapsed: boolean;
  hidden: boolean;
}): React.ReactNode {
  return (
    <span className="flex size-5 shrink-0 items-center justify-center">
      {!hidden &&
        (collapsed ? (
          <ChevronRight className="size-3" />
        ) : (
          <ChevronDown className="size-3" />
        ))}
    </span>
  );
}

const GROUP_HEADER_CLASS =
  "flex w-full items-center gap-2 rounded-md px-2 pt-1 pb-1.5 text-left font-medium text-muted-foreground text-xs uppercase tracking-wider";

// A tag group's header: a button that folds the group, or, while a filter
// holds every group open, plain text, so it is not announced as a dimmed
// button that does nothing.
function GroupHeader({
  foldable,
  collapsed,
  onToggle,
  children,
}: {
  foldable: boolean;
  collapsed: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}): React.ReactNode {
  if (!foldable) {
    return (
      <div className={GROUP_HEADER_CLASS} data-testid="tag-group-header">
        <GroupChevron collapsed={false} hidden />
        {children}
      </div>
    );
  }
  return (
    <button
      aria-expanded={!collapsed}
      className={cn(
        GROUP_HEADER_CLASS,
        "outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-foreground/60 focus-visible:ring-inset"
      )}
      data-testid="tag-group-header"
      onClick={onToggle}
      type="button"
    >
      <GroupChevron collapsed={collapsed} hidden={false} />
      {children}
    </button>
  );
}

// What a list says when a trigger filter leaves nothing in it, with a way
// back to every workflow instead of a dead end.
export function FilteredEmpty({
  text,
  onReset,
}: {
  text: string;
  onReset: () => void;
}): React.ReactNode {
  return (
    <div className="flex flex-col items-center gap-1 py-4 text-sm">
      <p className="text-center text-muted-foreground">{text}</p>
      <button
        className="rounded-sm text-foreground underline underline-offset-4 hover:text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-foreground/60"
        data-testid="trigger-filter-reset"
        onClick={onReset}
        type="button"
      >
        Show all workflows
      </button>
    </div>
  );
}

export function TagsPanel({
  projectTags,
  workflowsByTagId,
  untaggedWorkflows,
  activeWorkflowId,
  loading,
  onResetFilter,
  filteredEmptyText = "No matching workflows",
  expandAll = false,
}: {
  projectTags: Tag[];
  workflowsByTagId: Record<string, WorkflowEntry[]>;
  untaggedWorkflows: WorkflowEntry[];
  activeWorkflowId: string | undefined;
  loading: boolean;
  // Set while a trigger filter is narrowing the list; an empty result then
  // offers a way back to every workflow instead of a dead end.
  onResetFilter?: () => void;
  // What the empty list says while a filter is on.
  filteredEmptyText?: string;
  // While a filter narrows the list, collapsed groups open so no
  // match hides behind a header.
  expandAll?: boolean;
}): React.ReactNode {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  const toggle = (key: string): void => {
    setCollapsed((prev) => toggleInSet(prev, key));
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const hasAny = projectTags.length > 0 || untaggedWorkflows.length > 0;

  if (!hasAny) {
    if (onResetFilter) {
      return <FilteredEmpty onReset={onResetFilter} text={filteredEmptyText} />;
    }
    return (
      <p className="py-4 text-center text-muted-foreground text-sm">
        No workflows
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-0.5">
      {projectTags.map((tag, index) => {
        const tagWorkflows = workflowsByTagId[tag.id] ?? [];
        const isCollapsed = !expandAll && collapsed.has(tag.id);
        return (
          <div className="flex flex-col gap-0.5" key={tag.id}>
            {index > 0 && <div className="my-1 border-t" />}
            <GroupHeader
              collapsed={isCollapsed}
              foldable={!expandAll}
              onToggle={() => toggle(tag.id)}
            >
              <span
                className="inline-block size-2 shrink-0 rounded-full"
                style={{ backgroundColor: tag.color }}
              />
              <TruncatedTooltip side="right" text={tag.name} />
              <span className="ml-auto normal-case tracking-normal">
                {tag.workflowCount}
              </span>
            </GroupHeader>
            {!isCollapsed &&
              tagWorkflows.map((w) => (
                <WorkflowItem
                  activeWorkflowId={activeWorkflowId}
                  key={w.id}
                  workflow={w}
                />
              ))}
          </div>
        );
      })}
      {untaggedWorkflows.length > 0 && (
        <>
          {projectTags.length > 0 && <div className="my-1 border-t" />}
          {(() => {
            const showHeader = projectTags.length > 0;
            const isCollapsed =
              !expandAll && showHeader && collapsed.has(UNTAGGED_KEY);
            return (
              <>
                {showHeader && (
                  <GroupHeader
                    collapsed={isCollapsed}
                    foldable={!expandAll}
                    onToggle={() => toggle(UNTAGGED_KEY)}
                  >
                    <span className="truncate">Untagged</span>
                    <span className="ml-auto normal-case tracking-normal">
                      {untaggedWorkflows.length}
                    </span>
                  </GroupHeader>
                )}
                {!isCollapsed &&
                  untaggedWorkflows.map((w) => (
                    <WorkflowItem
                      activeWorkflowId={activeWorkflowId}
                      key={w.id}
                      workflow={w}
                    />
                  ))}
              </>
            );
          })()}
        </>
      )}
    </div>
  );
}
