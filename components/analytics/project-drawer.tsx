"use client";

import { useAtom } from "jotai";
import { ChevronLeft, ChevronRight, Layers } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { analyticsProjectIdAtom } from "@/lib/atoms/analytics";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/utils";

const STORAGE_KEY = "keeperhub-analytics-drawer";
const DRAWER_WIDTH = 220;
const STRIP_WIDTH = 32;

type DrawerState = "open" | "collapsed";

type Project = {
  id: string;
  name: string;
  color: string | null;
};

function useDrawerState(): [DrawerState, (s: DrawerState) => void] {
  const [state, setState] = useState<DrawerState>("collapsed");

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "open" || stored === "collapsed") {
      setState(stored);
    }
  }, []);

  const setAndPersist = useCallback((next: DrawerState): void => {
    setState(next);
    localStorage.setItem(STORAGE_KEY, next);
  }, []);

  return [state, setAndPersist];
}

function useProjects(): { projects: Project[]; loading: boolean } {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const { data: activeOrg } = authClient.useActiveOrganization();
  const activeOrgId = activeOrg?.id ?? null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: activeOrgId is the refetch trigger on org switch; the endpoint scopes by the active org server-side, so it is not read in the body
  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    async function load(): Promise<void> {
      try {
        const res = await fetch("/api/projects");
        if (!res.ok) {
          return;
        }
        const data = (await res.json()) as Project[];
        if (!cancelled) {
          setProjects(data);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    load().catch(() => {
      if (!cancelled) {
        setLoading(false);
      }
    });

    return (): void => {
      cancelled = true;
    };
  }, [activeOrgId]);

  return { projects, loading };
}

export function ProjectDrawer(): ReactNode {
  const [state, setState] = useDrawerState();
  const [projectId, setProjectId] = useAtom(analyticsProjectIdAtom);
  const { projects, loading } = useProjects();

  if (state === "collapsed") {
    return (
      <button
        className="flex shrink-0 items-start justify-center border-r bg-background pt-3 transition-colors hover:bg-muted"
        onClick={() => setState("open")}
        style={{ width: STRIP_WIDTH }}
        type="button"
      >
        <div className="flex flex-col items-center gap-1">
          <ChevronRight className="size-3.5 text-muted-foreground" />
          <span
            className="max-h-[120px] overflow-hidden text-muted-foreground text-xs"
            style={{ writingMode: "vertical-lr" }}
          >
            Projects
          </span>
        </div>
      </button>
    );
  }

  return (
    <div
      className="flex shrink-0 flex-col border-r bg-background"
      style={{ width: DRAWER_WIDTH }}
    >
      <div className="flex items-center justify-between border-b px-3 py-2">
        <div className="flex items-center gap-1.5">
          <Layers className="size-3.5 text-muted-foreground" />
          <span className="font-medium text-sm">Projects</span>
        </div>
        <button
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          onClick={() => setState("collapsed")}
          title="Collapse"
          type="button"
        >
          <ChevronLeft className="size-4" />
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto p-1.5">
        <button
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors",
            projectId === null
              ? "bg-accent font-medium text-accent-foreground"
              : "text-muted-foreground hover:bg-muted hover:text-foreground"
          )}
          onClick={() => setProjectId(null)}
          type="button"
        >
          All Runs
        </button>

        {loading ? (
          <div className="px-2.5 py-3 text-xs text-muted-foreground">
            Loading...
          </div>
        ) : (
          projects.map((project) => (
            <button
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors",
                projectId === project.id
                  ? "bg-accent font-medium text-accent-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
              key={project.id}
              onClick={() => setProjectId(project.id)}
              type="button"
            >
              <span
                className="inline-block size-2.5 shrink-0 rounded-full"
                style={{
                  backgroundColor: project.color ?? "var(--color-text-muted)",
                }}
              />
              <span className="truncate">{project.name}</span>
            </button>
          ))
        )}
      </nav>
    </div>
  );
}
