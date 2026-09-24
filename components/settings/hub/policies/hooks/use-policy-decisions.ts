"use client";

import { useCallback, useEffect, useState } from "react";
import type { Page, PageMeta } from "@/lib/pagination";
import { useSettingsContext } from "../../settings-context";

export type Decision = {
  id: string;
  checkpoint: string;
  capability: string;
  resource: string | null;
  outcome: string;
  reason: string;
  matchedSids: string[] | null;
  governingPolicyIds: string[] | null;
  observedOnly: boolean;
  workflowId: string | null;
  createdAt: string;
};

const EMPTY_META: PageMeta = { total: 0, page: 1, pageSize: 25, totalPages: 1 };

export type PolicyDecisionsState = {
  decisions: Decision[] | null;
  meta: PageMeta;
  loading: boolean;
  refresh: () => Promise<void>;
};

export type PolicyDecisionsQuery = {
  /** Only the decisions this policy governed. */
  policyId?: string;
  /** Only the decisions whose governing policies no longer exist. */
  orphaned?: boolean;
  query?: string;
  page?: number;
};

/**
 * The decisions a policy has already made.
 *
 * Only governed actions appear: an organization with no policy writes no rows,
 * which is why an empty list reads as "nothing is governed yet" rather than as
 * a failure to load. Filtering and paging happen on the server, so a long
 * decision log never has to reach the browser to be searched.
 */
export function usePolicyDecisions(
  options?: PolicyDecisionsQuery
): PolicyDecisionsState {
  const { organizationId } = useSettingsContext();
  const [decisions, setDecisions] = useState<Decision[] | null>(null);
  const [meta, setMeta] = useState<PageMeta>(EMPTY_META);
  const [loading, setLoading] = useState(false);

  const policyId = options?.policyId;
  const orphaned = options?.orphaned ?? false;
  const query = options?.query?.trim() ?? "";
  const page = options?.page ?? 1;

  const refresh = useCallback(async () => {
    if (!organizationId) {
      return;
    }
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page) });
      if (policyId) {
        params.set("policyId", policyId);
      }
      if (orphaned) {
        params.set("orphaned", "true");
      }
      if (query) {
        params.set("q", query);
      }
      const res = await fetch(
        `/api/organizations/${organizationId}/policy-decisions?${params.toString()}`
      );
      if (!res.ok) {
        setDecisions([]);
        setMeta(EMPTY_META);
        return;
      }
      const body = (await res.json()) as Page<Decision>;
      setDecisions(body.items ?? []);
      setMeta(body.meta ?? EMPTY_META);
    } finally {
      setLoading(false);
    }
  }, [organizationId, policyId, orphaned, query, page]);

  useEffect(() => {
    refresh().catch(() => undefined);
  }, [refresh]);

  return { decisions, meta, loading, refresh };
}
