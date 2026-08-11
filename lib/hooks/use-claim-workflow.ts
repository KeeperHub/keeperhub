"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api-client";
import { useSession } from "@/lib/auth-client";

const STORAGE_KEY = "pendingWorkflowClaim";

type PendingClaim = {
  workflowId: string;
  previousUserId: string;
};

export function getPendingClaim(): PendingClaim | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) {
      return null;
    }
    return JSON.parse(stored);
  } catch {
    return null;
  }
}

export function setPendingClaim(claim: PendingClaim): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(claim));
}

export function clearPendingClaim(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export function useClaimWorkflow(
  workflowId: string,
  loadExistingWorkflow: () => Promise<void>
): { claimPending: boolean } {
  const { data: session } = useSession();
  const [claimPending, setClaimPending] = useState(() => {
    const claim = getPendingClaim();
    return claim?.workflowId === workflowId;
  });
  const hasClaimedRef = useRef(false);

  useEffect(() => {
    if (hasClaimedRef.current) {
      return;
    }

    const claim = getPendingClaim();
    if (!claim || claim.workflowId !== workflowId) {
      setClaimPending(false);
      return;
    }

    const isAuthenticated =
      session?.user?.id &&
      !session.user.email?.startsWith("temp-") &&
      session.user.name !== "Anonymous";

    const isDifferentUser = session?.user?.id !== claim.previousUserId;

    if (!(isAuthenticated && isDifferentUser)) {
      return;
    }

    hasClaimedRef.current = true;

    async function claimAutomatically(): Promise<void> {
      try {
        await api.workflow.claim(workflowId);
        clearPendingClaim();
        setClaimPending(false);
        await loadExistingWorkflow();
      } catch {
        clearPendingClaim();
        setClaimPending(false);
      }
    }

    claimAutomatically().catch(() => {
      clearPendingClaim();
      setClaimPending(false);
    });
  }, [session, workflowId, loadExistingWorkflow]);

  return { claimPending };
}
