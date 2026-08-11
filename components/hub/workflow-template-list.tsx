"use client";

import { useRouter } from "next/navigation";
import type { MouseEvent } from "react";
import type { SavedWorkflow } from "@/lib/api-client";
import type { VoteDirection } from "@/lib/workflow/editor/votes";
import type { VoteOverridesMap } from "./use-vote-overrides";
import { WorkflowTemplateRow } from "./workflow-template-row";

type WorkflowTemplateListProps = {
  workflows: SavedWorkflow[];
  featuredIds?: Set<string>;
  voteOverrides: VoteOverridesMap;
  onVote: (workflowId: string, direction: VoteDirection) => Promise<void>;
};

export function WorkflowTemplateList({
  workflows,
  featuredIds,
  voteOverrides,
  onVote,
}: WorkflowTemplateListProps): React.ReactElement | null {
  const router = useRouter();

  const handlePreview = (e: MouseEvent, workflowId: string): void => {
    e.stopPropagation();
    router.push(`/workflows/${workflowId}`);
  };

  if (workflows.length === 0) {
    return null;
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: matches the marketplace table — UI-SPEC §5 mandates a CSS grid layout (grid-cols-[48px_1fr_220px_96px_96px_136px]); a native <table> cannot drive grid tracks. The role="table"/"row"/"columnheader" hierarchy preserves screen-reader semantics.
    <div
      aria-label="Workflow templates"
      className="overflow-hidden rounded-xl border border-border/20 bg-[var(--color-hub-card)]"
      role="table"
    >
      {/* biome-ignore lint/a11y/useSemanticElements: see role="table" justification above. */}
      {/* biome-ignore lint/a11y/useFocusableInteractive: header row is a label container, not a tab stop. */}
      <div
        className="grid grid-cols-[48px_1fr_220px_96px_96px_136px] items-center gap-x-3 border-border/30 border-b bg-[var(--color-hub-overlay)] px-4 py-3 font-normal text-muted-foreground text-xs uppercase tracking-widest"
        role="row"
      >
        {/* biome-ignore lint/a11y/useSemanticElements: see role="table" justification above. */}
        {/* biome-ignore lint/a11y/useFocusableInteractive: column headers are static labels. */}
        <span role="columnheader">{/* icon */}</span>
        {/* biome-ignore lint/a11y/useSemanticElements: see role="table" justification above. */}
        {/* biome-ignore lint/a11y/useFocusableInteractive: column headers are static labels. */}
        <span role="columnheader">Name</span>
        {/* biome-ignore lint/a11y/useSemanticElements: see role="table" justification above. */}
        {/* biome-ignore lint/a11y/useFocusableInteractive: column headers are static labels. */}
        <span className="hidden lg:inline" role="columnheader">
          Tags
        </span>
        {/* biome-ignore lint/a11y/useSemanticElements: see role="table" justification above. */}
        {/* biome-ignore lint/a11y/useFocusableInteractive: column headers are static labels. */}
        <span className="text-right" role="columnheader">
          Uses
        </span>
        {/* biome-ignore lint/a11y/useSemanticElements: see role="table" justification above. */}
        {/* biome-ignore lint/a11y/useFocusableInteractive: column headers are static labels. */}
        <span className="text-right" role="columnheader">
          Votes
        </span>
        {/* biome-ignore lint/a11y/useSemanticElements: see role="table" justification above. */}
        {/* biome-ignore lint/a11y/useFocusableInteractive: column headers are static labels. */}
        <span className="hidden text-right md:inline" role="columnheader">
          {/* featured */}
        </span>
      </div>
      {workflows.map((workflow) => {
        const override = voteOverrides[workflow.id];
        return (
          <WorkflowTemplateRow
            isFeatured={featuredIds?.has(workflow.id) ?? false}
            key={workflow.id}
            onPreview={(e) => handlePreview(e, workflow.id)}
            onVote={(direction) => onVote(workflow.id, direction)}
            score={override?.score ?? workflow.score ?? 0}
            userVote={
              override ? override.userVote : (workflow.userVote ?? null)
            }
            workflow={workflow}
          />
        );
      })}
    </div>
  );
}
