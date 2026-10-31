// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAll: vi.fn(),
  session: { data: null as unknown, isPending: false },
  projects: { data: [] as unknown[], isLoading: false },
  activeOrg: { data: null as unknown, isPending: false },
}));

vi.mock("@/lib/api-client", () => ({
  api: { workflow: { getAll: mocks.getAll } },
}));
vi.mock("@/lib/auth-client", () => ({
  useSession: () => mocks.session,
  authClient: { useActiveOrganization: () => mocks.activeOrg },
}));
vi.mock("@/lib/hooks/use-org-data", () => ({
  useProjects: () => mocks.projects,
  useTags: () => ({ data: [] }),
}));

import { getDefaultStore } from "jotai";
import {
  PickerDataProvider,
  usePickerData,
} from "@/components/workflow-picker-data";
import { activeOrgScopeAtom } from "@/lib/atoms/organization";
import { refetchSidebar } from "@/lib/refetch-sidebar";

let container: HTMLDivElement;
let root: Root;
let seen: ReturnType<typeof usePickerData> | null = null;

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function Reader(): null {
  seen = usePickerData();
  return null;
}

function signedIn(org: string | null): unknown {
  return {
    data: {
      user: { name: "Dana", email: "dana@example.com" },
      session: { activeOrganizationId: org },
    },
    isPending: false,
  };
}

function workflow(
  id: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id,
    name: id,
    updatedAt: "2026-10-01T00:00:00.000Z",
    nodes: [],
    ...extra,
  };
}

async function render(): Promise<void> {
  await act(async () => {
    root.render(
      <PickerDataProvider>
        <Reader />
      </PickerDataProvider>
    );
    await Promise.resolve();
  });
}

// The org the projects store is scoped to, which the app's OrgDataSync sets.
async function setScope(org: string | null): Promise<void> {
  await act(async () => {
    getDefaultStore().set(activeOrgScopeAtom, org);
    await Promise.resolve();
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.projects = { data: [], isLoading: false };
  mocks.activeOrg = { data: null, isPending: false };
  getDefaultStore().set(activeOrgScopeAtom, null);
  seen = null;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("PickerDataProvider", () => {
  it("loads the list once and groups it by project", async () => {
    mocks.session = signedIn("org-1") as typeof mocks.session;
    mocks.getAll.mockResolvedValue([
      workflow("a", { projectId: "p-1" }),
      workflow("b"),
      workflow("__current__"),
      workflow("gone", { deletedAt: "2026-10-02T00:00:00.000Z" }),
    ]);
    await render();
    await settle();
    expect(mocks.getAll).toHaveBeenCalledOnce();
    expect(seen?.loading).toBe(false);
    expect(seen?.workflows.map((w) => w.id)).toEqual(["a", "b"]);
    expect(seen?.byProject["p-1"]?.map((w) => w.id)).toEqual(["a"]);
    expect(seen?.ungrouped.map((w) => w.id)).toEqual(["b"]);
  });

  it("makes no request for a signed-out or anonymous visitor", async () => {
    mocks.session = { data: null, isPending: false };
    await render();
    expect(mocks.getAll).not.toHaveBeenCalled();
    expect(seen?.loading).toBe(false);

    mocks.session = {
      data: {
        user: { name: "Anonymous", email: "temp-1@http://localhost" },
        session: { activeOrganizationId: "org-1" },
      },
      isPending: false,
    };
    await render();
    expect(mocks.getAll).not.toHaveBeenCalled();
  });

  it("holds the list for a member's first projects load in an org only", async () => {
    mocks.projects = { data: [], isLoading: true };
    mocks.activeOrg = { data: null, isPending: true };
    mocks.getAll.mockResolvedValue([]);
    // Signed out, or a guest: no projects to wait for.
    mocks.session = { data: null, isPending: false };
    await render();
    expect(seen?.awaitingProjects).toBe(false);
    mocks.session = {
      data: {
        user: { name: "Anonymous", email: "temp-1@http://localhost" },
        session: { activeOrganizationId: "org-1" },
      },
      isPending: false,
    };
    await render();
    expect(seen?.awaitingProjects).toBe(false);

    // A member, while the active org is looked up.
    mocks.session = signedIn("org-1") as typeof mocks.session;
    await render();
    expect(seen?.awaitingProjects).toBe(true);
    // Found, a render before OrgDataSync sets the scope from it.
    mocks.activeOrg = { data: { id: "org-1" }, isPending: false };
    await render();
    expect(seen?.awaitingProjects).toBe(true);
    await setScope("org-1");
    expect(seen?.awaitingProjects).toBe(true);
    mocks.projects = { data: [{ id: "p-1" }], isLoading: false };
    await render();
    expect(seen?.awaitingProjects).toBe(false);
    // A refresh does not hold the list.
    mocks.projects = { data: [], isLoading: true };
    await render();
    expect(seen?.projectsLoading).toBe(true);
    expect(seen?.awaitingProjects).toBe(false);
    // Another org's projects are a first load again.
    mocks.session = signedIn("org-2") as typeof mocks.session;
    mocks.activeOrg = { data: { id: "org-2" }, isPending: false };
    await setScope("org-2");
    expect(seen?.awaitingProjects).toBe(true);
  });

  it("does not hold the list when the projects can never load", async () => {
    // The session names an org, but none is active: deleted, or its lookup
    // failed. The projects store has no scope and never loads.
    mocks.projects = { data: [], isLoading: true };
    mocks.activeOrg = { data: null, isPending: false };
    mocks.session = signedIn("org-gone") as typeof mocks.session;
    mocks.getAll.mockResolvedValue([]);
    await render();
    expect(seen?.awaitingProjects).toBe(false);
  });

  it("refetches on refetchSidebar and keeps the list when a refetch fails", async () => {
    mocks.session = signedIn("org-1") as typeof mocks.session;
    mocks.getAll.mockResolvedValueOnce([workflow("a")]);
    await render();
    await settle();
    mocks.getAll.mockRejectedValueOnce(new Error("offline"));
    await act(async () => {
      refetchSidebar();
      await Promise.resolve();
    });
    await settle();
    expect(mocks.getAll).toHaveBeenCalledTimes(2);
    expect(seen?.workflows.map((w) => w.id)).toEqual(["a"]);
  });

  it("drops the old org's list when a refetch after an org switch fails", async () => {
    mocks.session = signedIn("org-1") as typeof mocks.session;
    mocks.getAll.mockResolvedValueOnce([workflow("a")]);
    await render();
    await settle();
    mocks.getAll.mockRejectedValueOnce(new Error("offline"));
    await act(async () => {
      refetchSidebar({ orgChanged: true });
      await Promise.resolve();
    });
    await settle();
    expect(seen?.workflows).toEqual([]);
  });
});
