"use client";

import {
  ArrowBigDown,
  ArrowBigUp,
  Star,
  Workflow as WorkflowIcon,
} from "lucide-react";
import type { KeyboardEvent, MouseEvent } from "react";
import type { SavedWorkflow } from "@/lib/api-client";
import { formatCompactNumber } from "@/lib/utils/format-number";
import type { VoteDirection } from "@/lib/workflow/editor/votes";
import { PlanRequiredBadge } from "./plan-required-badge";
import { WORKFLOW_LIST_GRID_COLUMNS } from "./workflow-list-grid";

type WorkflowTemplateRowProps = {
  workflow: SavedWorkflow;
  isFeatured?: boolean;
  score?: number;
  userVote?: VoteDirection | null;
  onPreview: (e: MouseEvent) => void;
  onVote?: (direction: VoteDirection) => void;
};

function voteCountColorClass(userVote: VoteDirection | null): string {
  if (userVote === "upvote") {
    return "text-[var(--color-text-accent)]";
  }
  if (userVote === "downvote") {
    return "text-[var(--color-text-error)]";
  }
  return "text-foreground";
}

// The 3rem Uses track on phones fits four digits; larger counts go compact (1.2M).
function usesLabel(count: number): string {
  return count < 10_000
    ? count.toLocaleString("en-US")
    : formatCompactNumber(count);
}

export function WorkflowTemplateRow({
  workflow,
  isFeatured = false,
  score = 0,
  userVote = null,
  onPreview,
  onVote,
}: WorkflowTemplateRowProps): React.ReactElement {
  const handleClick = (e: MouseEvent<HTMLElement>): void => {
    onPreview(e);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onPreview(e as unknown as MouseEvent);
    }
  };

  const upActive = userVote === "upvote";
  const downActive = userVote === "downvote";
  const uses = workflow.duplicateCount ?? 0;
  const badges =
    workflow.requiredPlan || isFeatured ? (
      <>
        {workflow.requiredPlan ? (
          <PlanRequiredBadge
            className="inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-[var(--color-bg-accent)] px-2 py-0.5 font-semibold"
            plan={workflow.requiredPlan}
          />
        ) : null}
        {isFeatured ? (
          <span className="inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-[var(--color-bg-accent)] px-2 py-0.5 font-semibold text-[0.625rem] text-[var(--color-text-accent)]">
            <Star className="size-2.5 fill-[var(--color-text-accent)] text-[var(--color-text-accent)]" />
            Featured
          </span>
        ) : null}
      </>
    ) : null;

  return (
    // biome-ignore lint/a11y/useSemanticElements: row uses an <article> with the row A11y role per UI-SPEC §2 to act as a click target with the ::before overlay; nested vote buttons forbid wrapping <a>.
    <article
      aria-label={`Open ${workflow.name} preview`}
      className={`group relative grid min-h-[3rem] cursor-pointer ${WORKFLOW_LIST_GRID_COLUMNS} items-center border-border/20 border-b bg-[var(--color-hub-card)] px-4 py-3 transition-colors duration-100 ease before:absolute before:inset-0 before:z-[1] before:cursor-pointer before:content-[''] last:border-b-0 even:bg-[var(--color-hub-overlay)] hover:bg-[var(--color-hub-icon-bg)] motion-reduce:transition-none`}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: UI-SPEC §2 mandates an <article> with the row A11y role for rowgroup/row semantics; the row is interactive via the ::before overlay and onKeyDown handler.
      role="row"
      tabIndex={0}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none relative z-[2] hidden size-6 shrink-0 items-center justify-center rounded-md bg-[var(--color-hub-icon-bg)] text-muted-foreground @xl:inline-flex"
      >
        <WorkflowIcon className="size-3.5" />
      </span>

      <div className="pointer-events-none relative z-[2] min-w-0">
        <span className="block font-semibold text-foreground text-sm @max-workflow-list-full:line-clamp-2 @max-workflow-list-full:wrap-anywhere @workflow-list-full:truncate">
          {workflow.name}
        </span>
      </div>

      {/* MARKETPLACE_BADGE_SLOT: reserved for cross-tab discovery — Phase 44 HUBV2-08 forbids rendering anything here. Tab-strip is the only cross-tab discovery mechanism. */}

      {/* One line: long tag names shorten instead of wrapping. */}
      <div className="pointer-events-none relative z-[2] hidden min-w-0 gap-1 overflow-hidden @workflow-list-tags:flex">
        {workflow.publicTags?.slice(0, 3).map((tag) => (
          <span
            className="min-w-0 truncate rounded-full bg-[var(--color-hub-icon-bg)] px-2 py-0.5 font-medium text-[0.625rem] text-muted-foreground"
            key={tag.slug}
          >
            {tag.name}
          </span>
        ))}
      </div>

      {/* Below @xl the badges take a second line, so Uses and Votes span both. */}
      <span className="pointer-events-none relative z-[2] text-right font-semibold text-foreground text-sm tabular-nums @max-xl:row-span-2">
        {usesLabel(uses)}
      </span>

      {onVote ? (
        <div className="pointer-events-auto relative z-[2] flex items-center justify-end gap-0.5 @max-xl:row-span-2">
          <button
            aria-label="Upvote"
            aria-pressed={upActive}
            className={`relative rounded p-0.5 transition-colors duration-150 after:absolute after:-inset-y-1.5 after:right-0 after:-left-1.5 after:content-[''] motion-reduce:transition-none ${
              upActive
                ? "cursor-default text-[var(--color-text-accent)]"
                : "text-muted-foreground/50 hover:text-[var(--color-text-accent)]"
            }`}
            onClick={(e) => {
              e.stopPropagation();
              if (upActive) {
                return;
              }
              onVote("upvote");
            }}
            type="button"
          >
            <ArrowBigUp
              className={`size-4 ${upActive ? "fill-[var(--color-text-accent)]" : ""}`}
            />
          </button>
          <span
            aria-label={`Vote score ${score}`}
            className={`min-w-[1rem] text-center font-semibold text-[0.6875rem] tabular-nums ${voteCountColorClass(userVote)}`}
            role="status"
          >
            {score}
          </span>
          <button
            aria-label="Downvote"
            aria-pressed={downActive}
            className={`relative rounded p-0.5 transition-colors duration-150 after:absolute after:-inset-y-1.5 after:-right-1.5 after:left-0 after:content-[''] motion-reduce:transition-none ${
              downActive
                ? "cursor-default text-[var(--color-text-error)]"
                : "text-muted-foreground/50 hover:text-[var(--color-text-error)]"
            }`}
            onClick={(e) => {
              e.stopPropagation();
              if (downActive) {
                return;
              }
              onVote("downvote");
            }}
            type="button"
          >
            <ArrowBigDown
              className={`size-4 ${downActive ? "fill-[var(--color-text-error)]" : ""}`}
            />
          </button>
        </div>
      ) : (
        <span className="pointer-events-none relative z-[2] text-right font-semibold text-foreground text-sm tabular-nums @max-xl:row-span-2">
          {score}
        </span>
      )}

      {/* Under the name on narrow tables, in its own column from @xl. */}
      {badges ? (
        <div className="pointer-events-auto relative z-[2] col-start-1 row-start-2 mt-1 flex flex-wrap items-center gap-1 @xl:col-start-auto @xl:row-start-auto @xl:mt-0 @xl:justify-end @xl:justify-self-end @xl:gap-1.5">
          {badges}
        </div>
      ) : (
        <span aria-hidden="true" className="hidden @xl:inline" />
      )}
    </article>
  );
}
