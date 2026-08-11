"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api-client";
import { authClient } from "@/lib/auth-client";

/** Sentinel value meaning "no date filter". */
export const ALL = "all";

// Activity-feed type filter: resource categories map 1:1 to the audited
// resourceType the API filters on.
export const ACTIVITY_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: "workflow", label: "Workflows" },
  { value: "integration", label: "Connections" },
  { value: "project", label: "Projects" },
  { value: "tag", label: "Tags" },
  { value: "org_api_key", label: "Org API keys" },
  { value: "api_key", label: "API keys" },
  { value: "agentic_wallet", label: "Agentic wallets" },
  { value: "wallet", label: "Wallet (withdraw/export)" },
  { value: "safe", label: "Safe roles" },
  { value: "member", label: "Members" },
  { value: "organization", label: "Organization" },
  { value: "session", label: "Sessions" },
  { value: "user", label: "Account" },
];

export const PAGE_SIZE_OPTIONS = [5, 10, 25] as const;

export const EXPORT_RANGE_OPTIONS: { value: string; label: string }[] = [
  { value: ALL, label: "All time" },
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
];

export const DATE_PRESET_OPTIONS: { value: string; label: string }[] = [
  { value: ALL, label: "Any time" },
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
];

export type FilterDimension =
  | "person"
  | "activity"
  | "project"
  | "workflow"
  | "tag"
  | "date";

export const FILTER_DIMENSIONS: { id: FilterDimension; label: string }[] = [
  { id: "person", label: "Person" },
  { id: "activity", label: "Activity type" },
  { id: "project", label: "Project" },
  { id: "workflow", label: "Workflow" },
  { id: "tag", label: "Tag" },
  { id: "date", label: "Date" },
];

export type AuditActivityMember = {
  userId: string;
  name: string | null;
  email: string | null;
  role: string | null;
  image: string | null;
};

export type ResourceOption = { id: string; label: string };

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function toggle(list: string[], value: string): string[] {
  return list.includes(value)
    ? list.filter((v) => v !== value)
    : [...list, value];
}

export const DEFAULT_AUDIT_PAGE_SIZE = 5;

// Wait this long after the last keystroke before searching, so typing doesn't
// fire a request per character.
const SEARCH_DEBOUNCE_MS = 500;

/**
 * State + data for the audit activity filter builder. Owns the selected values
 * per dimension (person/activity/project/workflow/tag/date), the page size,
 * the option lists (members from org context; projects/workflows/tags fetched
 * once), and which dimensions are currently shown as chips. Exposes a derived
 * `feedParams` ready to spread into <ActivityFeed>.
 */
export function useAuditActivity(options?: {
  initialPageSize?: number;
  initialSearch?: string;
}) {
  const [people, setPeople] = useState<string[]>([]);
  const [types, setTypes] = useState<string[]>([]);
  const [projects, setProjects] = useState<string[]>([]);
  const [workflows, setWorkflows] = useState<string[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [datePreset, setDatePreset] = useState<string>(ALL);
  const [pageSize, setPageSize] = useState<number>(
    options?.initialPageSize ?? DEFAULT_AUDIT_PAGE_SIZE
  );

  // Free-text search. `searchText` is the raw input (kept responsive); `search`
  // is the debounced value that actually drives the query, so typing doesn't
  // fire a request per keystroke.
  const [searchText, setSearchText] = useState(options?.initialSearch ?? "");
  const [search, setSearch] = useState(options?.initialSearch ?? "");
  useEffect(() => {
    const id = setTimeout(
      () => setSearch(searchText.trim()),
      SEARCH_DEBOUNCE_MS
    );
    return () => clearTimeout(id);
  }, [searchText]);

  // Option lists for the specific-resource dimensions.
  const [projectOptions, setProjectOptions] = useState<ResourceOption[]>([]);
  const [tagOptions, setTagOptions] = useState<ResourceOption[]>([]);
  const [workflowOptions, setWorkflowOptions] = useState<ResourceOption[]>([]);

  const { data: activeOrg } = authClient.useActiveOrganization();
  const activeOrgId = activeOrg?.id ?? null;

  // Projects and tags pickers, reloaded when the active org changes so a switch
  // doesn't leave the previous org's options in the filter bar.
  // biome-ignore lint/correctness/useExhaustiveDependencies: activeOrgId is the refetch trigger on org switch; the endpoints scope by the active org server-side, so it is not read in the body
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [proj, tg] = await Promise.all([
          api.project.getAll(),
          api.tag.getAll(),
        ]);
        if (cancelled) {
          return;
        }
        setProjectOptions(proj.map((p) => ({ id: p.id, label: p.name })));
        setTagOptions(tg.map((t) => ({ id: t.id, label: t.name })));
      } catch {
        // Best-effort: an empty picker is fine; the feed still works.
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [activeOrgId]);

  // Workflow picker cascades to the selected project(s)/tag(s); the scoping is
  // applied server-side by /api/workflows, never by filtering a full list here.
  // biome-ignore lint/correctness/useExhaustiveDependencies: activeOrgId is the refetch trigger on org switch; the endpoint scopes by the active org server-side, so it is not read in the body
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const requests =
          projects.length === 0 && tags.length === 0
            ? [api.workflow.getAll()]
            : [
                ...projects.map((projectId) =>
                  api.workflow.getAll({ projectId })
                ),
                ...tags.map((tagId) => api.workflow.getAll({ tagId })),
              ];
        const results = await Promise.all(requests);
        if (cancelled) {
          return;
        }
        const byId = new Map<string, ResourceOption>();
        for (const list of results) {
          for (const w of list) {
            if (w.name !== "__current__") {
              byId.set(w.id, { id: w.id, label: w.name });
            }
          }
        }
        setWorkflowOptions([...byId.values()]);
      } catch {
        // Best-effort: an empty picker is fine; the feed still works.
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [projects, tags, activeOrgId]);

  const members: AuditActivityMember[] = useMemo(() => {
    const list = (activeOrg?.members ?? []) as Array<{
      userId: string;
      role?: string | null;
      user?: {
        name?: string | null;
        email?: string | null;
        image?: string | null;
      };
    }>;
    return list.map((m) => ({
      userId: m.userId,
      name: m.user?.name ?? null,
      email: m.user?.email ?? null,
      role: m.role ?? null,
      image: m.user?.image ?? null,
    }));
  }, [activeOrg]);

  const feedParams = useMemo(() => {
    const from =
      datePreset === ALL
        ? undefined
        : new Date(Date.now() - Number(datePreset) * MS_PER_DAY).toISOString();
    return {
      limit: pageSize,
      resourceTypes: types.length > 0 ? types : undefined,
      actorUserIds: people.length > 0 ? people : undefined,
      projectIds: projects.length > 0 ? projects : undefined,
      tagIds: tags.length > 0 ? tags : undefined,
      workflowIds: workflows.length > 0 ? workflows : undefined,
      from,
      search: search || undefined,
    };
  }, [pageSize, types, people, projects, workflows, tags, datePreset, search]);

  return {
    // selections
    people,
    setPeople,
    types,
    setTypes,
    projects,
    setProjects,
    workflows,
    setWorkflows,
    tags,
    setTags,
    datePreset,
    setDatePreset,
    pageSize,
    setPageSize,
    searchText,
    setSearchText,
    // options
    members,
    projectOptions,
    workflowOptions,
    tagOptions,
    // derived
    feedParams,
    // helpers
    toggleValue: toggle,
  };
}
