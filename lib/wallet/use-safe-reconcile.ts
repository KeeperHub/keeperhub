"use client";

import { useCallback, useState } from "react";
import { toast } from "sonner";

type ReconcileSummary = {
  adopted: number;
  alreadyInDb: number;
  noOnchainSafe: number;
  failed: number;
  rolesSynced: number;
  rolesNotInstalled: number;
  rolesFailed: number;
};

function reportSummary(summary: ReconcileSummary): void {
  const { adopted, alreadyInDb, failed, rolesSynced, rolesFailed } = summary;
  const parts: string[] = [];
  if (adopted > 0) {
    parts.push(`adopted ${adopted} Safe${adopted === 1 ? "" : "s"}`);
  }
  if (rolesSynced > 0) {
    parts.push(
      `refreshed ${rolesSynced} policy set${rolesSynced === 1 ? "" : "s"}`
    );
  }
  if (parts.length > 0) {
    toast.success(`Sync from chain: ${parts.join(", ")}.`);
    return;
  }
  const failures = failed + rolesFailed;
  if (failures > 0) {
    toast.warning(
      `Sync completed with ${failures} chain operation${failures === 1 ? "" : "s"} that failed; nothing new adopted.`
    );
    return;
  }
  toast.info(
    `Sync complete. ${alreadyInDb} Safe${alreadyInDb === 1 ? "" : "s"} already in sync with chain.`
  );
}

/**
 * Adopts any Safe that exists on chain at the org's deterministic address but
 * is not tracked in the database yet. Used after a failed deploy attempt.
 */
export function useSafeReconcile(onAdopted: () => Promise<unknown>): {
  reconciling: boolean;
  reconcile: () => Promise<void>;
} {
  const [reconciling, setReconciling] = useState(false);

  const reconcile = useCallback(async (): Promise<void> => {
    if (reconciling) {
      return;
    }
    setReconciling(true);
    try {
      const res = await fetch("/api/user/safe/reconcile-all", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });
      const data = (await res.json()) as {
        success?: boolean;
        error?: string;
        summary?: ReconcileSummary;
      };
      if (!(res.ok && data.success && data.summary)) {
        toast.error(data.error ?? "Sync from chain failed");
        return;
      }
      // Refresh the in-memory Safe list whenever anything changed on chain,
      // either a new adoption OR a policy update on an existing Safe.
      if (data.summary.adopted > 0 || data.summary.rolesSynced > 0) {
        await onAdopted();
      }
      reportSummary(data.summary);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Sync from chain failed"
      );
    } finally {
      setReconciling(false);
    }
  }, [reconciling, onAdopted]);

  return { reconciling, reconcile };
}
