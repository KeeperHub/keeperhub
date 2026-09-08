"use client";

import { Search, Workflow } from "lucide-react";
import Link from "next/link";
import type { VoteOverridesMap } from "@/components/hub/use-vote-overrides";
import { WorkflowTemplateGrid } from "@/components/hub/workflow-template-grid";
import { WorkflowTemplateList } from "@/components/hub/workflow-template-list";
import { Button } from "@/components/ui/button";
import type { SavedWorkflow } from "@/lib/api-client";
import type { VoteDirection } from "@/lib/workflow/editor/votes";

type HubResultsProps = {
  communityWorkflows: SavedWorkflow[];
  searchResults: SavedWorkflow[] | null;
  isSearchActive: boolean;
  featuredIds?: Set<string>;
  onClearFilters?: () => void;
  viewMode: "cards" | "list"; // HUB-18 — branches on cookie-driven view
  voteOverrides: VoteOverridesMap;
  onVote: (workflowId: string, direction: VoteDirection) => Promise<void>;
};

export function HubResults({
  communityWorkflows,
  searchResults,
  isSearchActive,
  featuredIds,
  onClearFilters,
  viewMode,
  voteOverrides,
  onVote,
}: HubResultsProps): React.ReactElement {
  const workflows = isSearchActive ? searchResults : communityWorkflows;
  const isEmpty = !workflows || workflows.length === 0;

  // Single shared wrapper so `data-view-mode` is always emitted with the
  // current toggle state — populated and empty branches stay in sync (HUB-22)
  // and test selectors don't depend on whether any templates exist.
  return (
    <section data-view-mode={viewMode}>
      {(() => {
        if (isEmpty) {
          if (isSearchActive) {
            return (
              <div
                className="flex flex-col items-center justify-center py-16 text-center"
                data-testid="hub-results-empty-search"
              >
                <Search className="mb-3 size-8 text-muted-foreground/40" />
                <p className="mb-3 text-muted-foreground text-sm">
                  No templates match your filters.
                </p>
                {onClearFilters && (
                  <Button
                    className="h-8 text-xs"
                    onClick={onClearFilters}
                    variant="outline"
                  >
                    Clear filters
                  </Button>
                )}
              </div>
            );
          }
          return (
            <div
              className="flex flex-col items-center justify-center py-16 text-center"
              data-testid="hub-results-empty"
            >
              <Workflow className="mb-3 size-8 text-muted-foreground/40" />
              <p className="mb-3 text-muted-foreground text-sm">
                No templates available yet.
              </p>
              <Button asChild className="h-8 text-xs" variant="outline">
                <Link href="/workflows/new">Create a workflow</Link>
              </Button>
            </div>
          );
        }
        if (viewMode === "list") {
          return (
            <WorkflowTemplateList
              featuredIds={featuredIds}
              onVote={onVote}
              voteOverrides={voteOverrides}
              workflows={workflows}
            />
          );
        }
        return (
          <WorkflowTemplateGrid
            featuredIds={featuredIds}
            onVote={onVote}
            voteOverrides={voteOverrides}
            workflows={workflows}
          />
        );
      })()}
    </section>
  );
}
