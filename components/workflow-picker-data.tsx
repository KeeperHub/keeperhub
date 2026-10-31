"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Project, SavedWorkflow, Tag } from "@/lib/api-client";
import { api } from "@/lib/api-client";
import { useSession } from "@/lib/auth-client";
import { useProjects, useTags } from "@/lib/hooks/use-org-data";
import { isAnonymousUser } from "@/lib/is-anonymous";
import { createLatestRequest } from "@/lib/latest-request";
import { registerSidebarRefetch } from "@/lib/refetch-sidebar";
import { filterPickerVisible } from "@/lib/workflow/soft-delete";
import { getPickerTriggerType } from "@/lib/workflow/trigger-display";
import { getTriggerConfig } from "@/lib/workflow/trigger-display-key";
import type { WorkflowEntry } from "./workflow-picker-list";

// The workflow lists' data, loaded once and shared by the sidebar's flyouts
// and the phone drawer.

type PickerData = {
  workflows: WorkflowEntry[];
  byProject: Record<string, WorkflowEntry[]>;
  ungrouped: WorkflowEntry[];
  projects: Project[];
  tags: Tag[];
  // The workflow list is loading.
  loading: boolean;
  projectsLoading: boolean;
  refetch: () => Promise<void>;
};

const PickerDataContext = createContext<PickerData | null>(null);

function groupWorkflows(workflows: WorkflowEntry[]): {
  byProject: Record<string, WorkflowEntry[]>;
  ungrouped: WorkflowEntry[];
} {
  const byProject: Record<string, WorkflowEntry[]> = {};
  const ungrouped: WorkflowEntry[] = [];

  for (const workflow of workflows) {
    if (workflow.projectId) {
      byProject[workflow.projectId] ??= [];
      byProject[workflow.projectId].push(workflow);
    } else {
      ungrouped.push(workflow);
    }
  }

  return { byProject, ungrouped };
}

export function PickerDataProvider({
  children,
}: {
  children: React.ReactNode;
}): React.ReactNode {
  const { data: session, isPending } = useSession();
  const [workflows, setWorkflows] = useState<SavedWorkflow[]>([]);
  const { data: projects, isLoading: projectsLoading } = useProjects();
  const { data: tags } = useTags();
  const [loading, setLoading] = useState(true);
  // A reply that lands after a newer list request was sent is dropped rather
  // than put back over the newer list.
  const latestFetch = useRef(createLatestRequest());
  // The organization the session is in, and the one the shown list was
  // loaded for. A failed fetch keeps the shown list only while they match.
  const sessionOrg = useRef<string | null>(null);
  const listOrg = useRef<string | null>(null);

  const fetchData = useCallback(
    async (options?: { clearOnFailure?: boolean }): Promise<void> => {
      const result = await latestFetch.current(() => api.workflow.getAll());
      // Only the latest request settles the list and the loading state.
      if (!result.latest) {
        return;
      }
      if (result.ok) {
        setWorkflows(result.value);
        // The org is read on reply: a reply sent before an org switch is
        // never the latest, as the session refresh sends a newer one.
        listOrg.current = sessionOrg.current;
      } else if (
        options?.clearOnFailure ||
        sessionOrg.current !== listOrg.current
      ) {
        // A failed refetch keeps the list already shown, unless it belongs
        // to another organization. A failed first load leaves it empty.
        setWorkflows([]);
        listOrg.current = sessionOrg.current;
      }
      setLoading(false);
    },
    []
  );

  useEffect(() => {
    // NAV-04: signed-out and anonymous visitors make no request; only
    // authenticated users fetch the list.
    if (isPending) {
      return;
    }
    if (!session?.user || isAnonymousUser(session.user)) {
      setLoading(false);
      return;
    }
    // Every org switch refreshes the session, whichever code path made it.
    sessionOrg.current =
      (session.session as { activeOrganizationId?: string | null })
        .activeOrganizationId ?? null;
    fetchData().catch(() => {
      /* intentional noop */
    });
  }, [isPending, session, fetchData]);

  useEffect(
    () =>
      registerSidebarRefetch((options) => {
        fetchData({ clearOnFailure: options?.orgChanged }).catch(() => {
          /* intentional noop */
        });
      }),
    [fetchData]
  );

  // A save that changes a workflow's trigger refetches the list (see
  // refetchSidebarIfTriggerChanged), so the rows read it from the fetched
  // nodes. Built once per fetch, so the rows (memoized) skip the trigger
  // labels and cron parsing on unrelated re-renders such as a drag-resize.
  const entries = useMemo(() => {
    const visible = filterPickerVisible(workflows).map((w) => {
      const triggerConfig = getTriggerConfig(w.nodes);
      return {
        ...w,
        triggerConfig,
        triggerType: getPickerTriggerType(triggerConfig),
      };
    });
    return { workflows: visible, ...groupWorkflows(visible) };
  }, [workflows]);

  const value = useMemo(
    (): PickerData => ({
      ...entries,
      projects,
      tags,
      loading,
      projectsLoading,
      refetch: () => fetchData(),
    }),
    [entries, projects, tags, loading, projectsLoading, fetchData]
  );

  return (
    <PickerDataContext.Provider value={value}>
      {children}
    </PickerDataContext.Provider>
  );
}

export function usePickerData(): PickerData {
  const data = useContext(PickerDataContext);
  if (!data) {
    throw new Error("usePickerData must be used inside PickerDataProvider");
  }
  return data;
}
