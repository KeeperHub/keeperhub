"use client";

import { useCallback, useState } from "react";
import { toast } from "sonner";
import type { Page, PageLinks, PageMeta } from "@/lib/pagination";
import type { PolicyDocument, PolicyEnforcementMode } from "@/lib/policy";
import { useSettingsContext } from "../settings-context";
import { useCachedSection } from "./use-cached-section";

export type PolicyCoverageSummary = {
  score: number;
  perCapability: {
    capability: string;
    bound: string[];
    unbound: string[];
    score: number;
  }[];
};

export type OrganizationPolicySummary = {
  /** Null when the stored document no longer compiles. */
  coverage: PolicyCoverageSummary | null;
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  enforcement: PolicyEnforcementMode;
  version: number;
  changeDelayHours: number;
  effectiveAt: string;
  protected: boolean;
  document: PolicyDocument;
  createdAt: string;
  updatedAt: string;
};

export type PolicyViolation = { sid?: string; message: string };

export type PoliciesState = {
  policies: OrganizationPolicySummary[];
  /** Row count and page count for the current query, from the server. */
  meta: PageMeta;
  loading: boolean;
  saving: boolean;
  /** Compile errors from the last attempted save, for display beside the editor. */
  violations: PolicyViolation[];
  /** Legal but probably unintended, e.g. a claimed scope nothing allows. */
  warnings: string[];
  create: (document: PolicyDocument) => Promise<boolean>;
  update: (
    id: string,
    patch: {
      enabled?: boolean;
      enforcement?: PolicyEnforcementMode;
      document?: PolicyDocument;
    }
  ) => Promise<boolean>;
  remove: (id: string) => Promise<boolean>;
  clearFeedback: () => void;
};

function policiesKey(
  organizationId: string | null,
  query: string,
  page: number
): string | null {
  // The query and page are part of the cache key because the server does the
  // filtering now. Without them a second search would read the first one's
  // cached page.
  return organizationId ? `policies:${organizationId}:${query}:${page}` : null;
}

const EMPTY_LINKS: PageLinks = {
  self: "",
  first: "",
  prev: null,
  next: null,
  last: "",
};

const EMPTY_META: PageMeta = { total: 0, page: 1, pageSize: 20, totalPages: 1 };

export function usePolicies(options?: {
  query?: string;
  page?: number;
}): PoliciesState {
  const query = options?.query?.trim() ?? "";
  const page = options?.page ?? 1;
  const { organizationId } = useSettingsContext();
  const [saving, setSaving] = useState(false);
  const [violations, setViolations] = useState<PolicyViolation[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);

  const section = useCachedSection<Page<OrganizationPolicySummary>>(
    policiesKey(organizationId, query, page),
    async () => {
      const params = new URLSearchParams({ page: String(page) });
      if (query) {
        params.set("q", query);
      }
      const res = await fetch(
        `/api/organizations/${organizationId}/policies?${params.toString()}`
      );
      if (!res.ok) {
        // A 403 here is the common case: the viewer is a member rather than an
        // admin. An empty list reads correctly for them.
        return { items: [], meta: EMPTY_META, _links: EMPTY_LINKS };
      }
      return (await res.json()) as Page<OrganizationPolicySummary>;
    }
  );

  const clearFeedback = useCallback(() => {
    setViolations([]);
    setWarnings([]);
  }, []);

  const handleResponse = useCallback(
    async (res: Response, successMessage: string): Promise<boolean> => {
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        violations?: PolicyViolation[];
        warnings?: string[];
      };
      if (res.ok) {
        setViolations([]);
        setWarnings(body.warnings ?? []);
        toast.success(successMessage);
        return true;
      }
      setViolations(body.violations ?? []);
      toast.error(body.error ?? "Could not save the policy");
      return false;
    },
    []
  );

  const create = useCallback(
    async (document: PolicyDocument): Promise<boolean> => {
      setSaving(true);
      try {
        const res = await fetch(
          `/api/organizations/${organizationId}/policies`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ document }),
          }
        );
        const ok = await handleResponse(res, "Policy created in monitor mode");
        if (ok) {
          await section.refetch();
        }
        return ok;
      } catch {
        toast.error("Could not save the policy");
        return false;
      } finally {
        setSaving(false);
      }
    },
    [organizationId, handleResponse, section]
  );

  const update = useCallback(
    async (
      id: string,
      patch: {
        enabled?: boolean;
        enforcement?: PolicyEnforcementMode;
        document?: PolicyDocument;
      }
    ): Promise<boolean> => {
      setSaving(true);
      try {
        const res = await fetch(
          `/api/organizations/${organizationId}/policies/${id}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(patch),
          }
        );
        const ok = await handleResponse(res, "Policy saved");
        if (ok) {
          await section.refetch();
        }
        return ok;
      } catch {
        toast.error("Could not save the policy");
        return false;
      } finally {
        setSaving(false);
      }
    },
    [organizationId, handleResponse, section]
  );

  const remove = useCallback(
    async (id: string): Promise<boolean> => {
      setSaving(true);
      try {
        const res = await fetch(
          `/api/organizations/${organizationId}/policies/${id}`,
          { method: "DELETE" }
        );
        if (res.ok) {
          await section.refetch();
          toast.success("Policy removed");
          return true;
        }
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        toast.error(body.error ?? "Could not remove the policy");
        return false;
      } catch {
        toast.error("Could not remove the policy");
        return false;
      } finally {
        setSaving(false);
      }
    },
    [organizationId, section]
  );

  return {
    policies: section.data?.items ?? [],
    meta: section.data?.meta ?? EMPTY_META,
    loading: section.loading,
    saving,
    violations,
    warnings,
    create,
    update,
    remove,
    clearFeedback,
  };
}
