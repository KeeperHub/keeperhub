"use client";

import { ArrowBigDown, ArrowBigUp, Star } from "lucide-react";
import type { KeyboardEvent, MouseEvent } from "react";
import type { SavedWorkflow } from "@/lib/api-client";
import type { VoteDirection } from "@/lib/workflow/editor/votes";
import { PlanRequiredBadge } from "./plan-required-badge";
import { WorkflowMiniMap } from "./workflow-mini-map";

type WorkflowTemplateCardProps = {
  workflow: SavedWorkflow;
  /**
   * @deprecated Tile no longer renders Use-template CTA; kept for caller compat.
   * The Use-template CTA lives in the workflow Preview/detail toolbar (plan 43-04).
   */
  isDuplicating?: boolean;
  isFeatured?: boolean;
  score?: number;
  userVote?: VoteDirection | null;
  className?: string;
  /** @deprecated See isDuplicating. */
  onDuplicate?: (e: MouseEvent) => void;
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
  return "text-muted-foreground";
}

function VoteCluster({
  score,
  userVote,
  onVote,
}: {
  score: number;
  userVote: VoteDirection | null;
  onVote: (direction: VoteDirection) => void;
}): React.ReactElement {
  const upActive = userVote === "upvote";
  const downActive = userVote === "downvote";

  return (
    <div className="pointer-events-auto relative z-[2] flex items-center gap-0.5">
      <button
        aria-label="Upvote"
        aria-pressed={upActive}
        className={`rounded p-0.5 transition-colors duration-150 motion-reduce:transition-none ${
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
        aria-label={`Score ${score}`}
        className={`min-w-[1rem] text-center font-semibold text-[0.6875rem] tabular-nums transition-colors duration-150 motion-reduce:transition-none ${voteCountColorClass(userVote)}`}
        role="status"
      >
        {score}
      </span>
      <button
        aria-label="Downvote"
        aria-pressed={downActive}
        className={`rounded p-0.5 transition-colors duration-150 motion-reduce:transition-none ${
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
  );
}

export function WorkflowTemplateCard({
  workflow,
  isFeatured = false,
  score = 0,
  userVote = null,
  className,
  onPreview,
  onVote,
}: WorkflowTemplateCardProps): React.ReactElement {
  const handleArticleClick = (e: MouseEvent<HTMLElement>): void => {
    onPreview(e);
  };

  const handleArticleKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onPreview(e as unknown as MouseEvent);
    }
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: tile is semantically an <article> that also acts as a link per UI-SPEC HUB-16; wrapping <a> is forbidden because it breaks nested-button (vote) accessibility.
    <article
      aria-label={`Open ${workflow.name} preview`}
      className={`group relative flex cursor-pointer flex-col overflow-hidden rounded-xl border border-border/20 bg-[var(--color-hub-card)] shadow-sm transition-colors duration-150 before:absolute before:inset-0 before:z-[1] before:cursor-pointer before:content-[''] hover:brightness-125 motion-reduce:transition-none ${className ?? "min-h-[340px]"}`}
      onClick={handleArticleClick}
      onKeyDown={handleArticleKeyDown}
      // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: UI-SPEC HUB-16 mandates <article role="link"> with the ::before overlay click pattern; nested vote buttons would be invalid descendants of an <a>.
      role="link"
      tabIndex={0}
    >
      <div className="pointer-events-none relative z-[2] flex flex-1 flex-col p-4">
        <div className="shrink-0">
          <h3 className="line-clamp-2 font-semibold text-sm leading-snug">
            {workflow.name}
          </h3>
          {workflow.description && (
            <p className="mt-1.5 line-clamp-3 text-muted-foreground/80 text-xs leading-relaxed">
              {workflow.description}
            </p>
          )}
        </div>

        <div className="pointer-events-none my-auto shrink opacity-30 transition-opacity duration-200 group-hover:opacity-50 motion-reduce:transition-none">
          <WorkflowMiniMap
            edges={workflow.edges}
            height={160}
            nodes={workflow.nodes}
            width={280}
          />
        </div>

        {workflow.publicTags && workflow.publicTags.length > 0 && (
          <div className="pointer-events-auto flex shrink-0 flex-wrap gap-1">
            {workflow.publicTags.slice(0, 3).map((tag) => (
              <span
                className="rounded-full bg-[var(--color-hub-icon-bg)] px-2 py-0.5 font-normal text-[0.625rem] text-muted-foreground"
                key={tag.slug}
              >
                {tag.name}
              </span>
            ))}
          </div>
        )}

        {/* Bottom row: vote cluster (LEFT) + badges (RIGHT) */}
        {(onVote || isFeatured || workflow.requiredPlan) && (
          <div
            className={`pointer-events-auto mt-2 flex shrink-0 items-center gap-2 ${onVote ? "justify-between" : "justify-end"}`}
          >
            {onVote && (
              <VoteCluster onVote={onVote} score={score} userVote={userVote} />
            )}
            <div className="flex shrink-0 items-center gap-1.5">
              {workflow.requiredPlan ? (
                <PlanRequiredBadge plan={workflow.requiredPlan} />
              ) : null}
              {isFeatured && (
                <span className="inline-flex h-[20px] shrink-0 items-center gap-1 rounded-full bg-[var(--color-bg-accent)] px-2">
                  <Star className="size-2.5 fill-[var(--color-text-accent)] text-[var(--color-text-accent)]" />
                  <span className="font-normal text-[0.625rem] text-[var(--color-text-accent)]">
                    Featured
                  </span>
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </article>
  );
}
