"use client";

import { useCallback, useState } from "react";
import { toast } from "sonner";
import { api, type SavedWorkflow, type VoteResponse } from "@/lib/api-client";
import { useSession } from "@/lib/auth-client";
import type { VoteDirection } from "@/lib/workflow/editor/votes";

export type VoteOverride = {
  score: number;
  userVote: VoteDirection | null;
};

export type VoteOverridesMap = Record<string, VoteOverride>;

export type UseVoteOverridesReturn = {
  voteOverrides: VoteOverridesMap;
  handleVote: (workflowId: string, direction: VoteDirection) => Promise<void>;
};

function voteValue(direction: VoteDirection): number {
  return direction === "upvote" ? 1 : -1;
}

function computeOptimisticVote(
  currentScore: number,
  currentVote: VoteDirection | null,
  direction: VoteDirection
): VoteOverride {
  if (currentVote === direction) {
    return { score: currentScore - voteValue(direction), userVote: null };
  }
  if (currentVote === null) {
    return { score: currentScore + voteValue(direction), userVote: direction };
  }
  return {
    score: currentScore - voteValue(currentVote) + voteValue(direction),
    userVote: direction,
  };
}

/**
 * Owns optimistic vote state for the Hub. Lifted to a parent that wraps both
 * Cards and List view so votes persist when the user toggles between views.
 */
export function useVoteOverrides(
  workflows: SavedWorkflow[]
): UseVoteOverridesReturn {
  const { data: session } = useSession();
  const [voteOverrides, setVoteOverrides] = useState<VoteOverridesMap>({});

  const handleVote = useCallback(
    async (workflowId: string, direction: VoteDirection): Promise<void> => {
      if (!session?.user) {
        toast.error("Sign in to vote on workflows");
        return;
      }

      const workflow = workflows.find((w) => w.id === workflowId);
      if (!workflow?.canVote) {
        toast.error("Use this template first to vote");
        return;
      }

      let snapshotVote: VoteDirection | null = null;
      let snapshotScore = 0;

      setVoteOverrides((prev) => {
        const override = prev[workflowId];
        snapshotVote = override?.userVote ?? workflow?.userVote ?? null;
        snapshotScore = override?.score ?? workflow?.score ?? 0;
        return {
          ...prev,
          [workflowId]: computeOptimisticVote(
            snapshotScore,
            snapshotVote,
            direction
          ),
        };
      });

      try {
        const result: VoteResponse = await api.workflow.voteWorkflow(
          workflowId,
          direction
        );
        setVoteOverrides((prev) => ({
          ...prev,
          [workflowId]: { score: result.score, userVote: result.userVote },
        }));
      } catch (error) {
        setVoteOverrides((prev) => ({
          ...prev,
          [workflowId]: { score: snapshotScore, userVote: snapshotVote },
        }));
        toast.error(error instanceof Error ? error.message : "Failed to vote");
      }
    },
    [session, workflows]
  );

  return { voteOverrides, handleVote };
}
