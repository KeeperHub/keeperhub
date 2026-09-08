"use client";

import { useRouter } from "next/navigation";
import { type MouseEvent, useState } from "react";
import { toast } from "sonner";
import { api, type SavedWorkflow } from "@/lib/api-client";
import { refetchSidebar } from "@/lib/refetch-sidebar";
import type { VoteDirection } from "@/lib/workflow/editor/votes";
import type { VoteOverridesMap } from "./use-vote-overrides";
import { WorkflowTemplateCard } from "./workflow-template-card";

type WorkflowTemplateGridProps = {
  workflows: SavedWorkflow[];
  featuredIds?: Set<string>;
  voteOverrides: VoteOverridesMap;
  onVote: (workflowId: string, direction: VoteDirection) => Promise<void>;
};

export function WorkflowTemplateGrid({
  workflows,
  featuredIds,
  voteOverrides,
  onVote,
}: WorkflowTemplateGridProps): React.ReactElement | null {
  const router = useRouter();
  const [duplicatingIds, setDuplicatingIds] = useState<Set<string>>(new Set());

  const handleDuplicate = async (
    e: MouseEvent,
    workflowId: string
  ): Promise<void> => {
    e.stopPropagation();

    if (duplicatingIds.has(workflowId)) {
      return;
    }

    setDuplicatingIds((prev) => new Set(prev).add(workflowId));

    try {
      const duplicated = await api.workflow.duplicate(workflowId);
      refetchSidebar();
      toast.success("Template duplicated");
      router.push(`/workflows/${duplicated.id}`);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to duplicate"
      );
    } finally {
      setDuplicatingIds((prev) => {
        const next = new Set(prev);
        next.delete(workflowId);
        return next;
      });
    }
  };

  const handlePreview = (e: MouseEvent, workflowId: string): void => {
    e.stopPropagation();
    router.push(`/workflows/${workflowId}`);
  };

  if (workflows.length === 0) {
    return null;
  }

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {workflows.map((workflow) => {
        const override = voteOverrides[workflow.id];
        return (
          <WorkflowTemplateCard
            isDuplicating={duplicatingIds.has(workflow.id)}
            isFeatured={featuredIds?.has(workflow.id) ?? false}
            key={workflow.id}
            onDuplicate={(e) => handleDuplicate(e, workflow.id)}
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
