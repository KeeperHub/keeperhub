// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  setActive: vi.fn(),
  refresh: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
  refetchSidebar: vi.fn(),
  getAll: vi.fn(),
  resetEditor: vi.fn(),
  invalidateFeatures: vi.fn(),
  refetchActive: vi.fn(),
  toastError: vi.fn(),
  // The org the auth client's refresh answers with.
  shown: "org-2" as string | null,
  // The active org's request's error, as the auth client gives it.
  activeError: null as { status?: number } | null,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mocks.push,
    replace: mocks.replace,
    refresh: mocks.refresh,
  }),
}));
// The auth client's active-org atom, as a small store: its value, and who
// listens.
const activeOrg = vi.hoisted(() => {
  type Value = {
    data: { id: string } | null;
    error: { status?: number } | null;
    isPending: boolean;
    isRefetching: boolean;
  };
  const listeners = new Set<(value: Value) => void>();
  const store = {
    value: {
      data: { id: "org-1" },
      error: null,
      isPending: false,
      isRefetching: false,
    } as Value,
    get: (): Value => store.value,
    set: (value: Value): void => {
      store.value = value;
      for (const listener of listeners) {
        listener(value);
      }
    },
    listen: (listener: (value: Value) => void): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return store;
});

// A refresh of the active org: under way, then answered with `mocks.shown`.
async function refreshActive(): Promise<void> {
  activeOrg.set({ ...activeOrg.get(), isRefetching: true });
  await Promise.resolve();
  activeOrg.set({
    data: mocks.shown ? { id: mocks.shown } : activeOrg.get().data,
    error: mocks.activeError,
    isPending: false,
    isRefetching: false,
  });
}

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useActiveOrganization: () => ({
      data: { id: "org-1" },
      isPending: false,
      error: mocks.activeError,
      refetch: mocks.refetchActive,
    }),
    organization: { setActive: mocks.setActive },
    $store: { atoms: { activeOrganization: activeOrg } },
  },
}));
vi.mock("sonner", () => ({ toast: { error: mocks.toastError } }));
vi.mock("@/hooks/use-features", () => ({
  invalidateFeatureSnapshot: mocks.invalidateFeatures,
}));
vi.mock("@/lib/api-client", () => ({
  api: { workflow: { getAll: mocks.getAll } },
}));
vi.mock("@/lib/hooks/use-org-data", () => ({
  useOrganizationsData: () => ({
    data: [],
    isLoading: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/lib/refetch-organizations", () => ({
  registerOrganizationRefetch: () => () => undefined,
}));
vi.mock("@/lib/refetch-sidebar", () => ({
  refetchSidebar: mocks.refetchSidebar,
}));
vi.mock("@/lib/workflow/store", async () => {
  const { atom } = await import("jotai");
  return {
    resetWorkflowStateForOrgSwitchAtom: atom(null, () => mocks.resetEditor()),
  };
});

import {
  activeOrgLoadFailed,
  useOrganization,
} from "@/lib/hooks/use-organization";

let container: HTMLDivElement;
let root: Root;
let switchOrganization: (orgId: string, fromPath?: string) => Promise<boolean> =
  () => Promise.resolve(false);

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let loadFailed = false;

function Probe(): null {
  const organization = useOrganization();
  switchOrganization = organization.switchOrganization;
  loadFailed = organization.loadFailed;
  return null;
}

beforeEach(() => {
  vi.clearAllMocks();
  window.history.pushState({}, "", "/hub");
  mocks.shown = "org-2";
  mocks.activeError = null;
  activeOrg.value = {
    data: { id: "org-1" },
    error: null,
    isPending: false,
    isRefetching: false,
  };
  mocks.refetchActive.mockImplementation(refreshActive);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<Probe />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("switchOrganization", () => {
  it("resolves true when the switch takes", async () => {
    mocks.setActive.mockResolvedValue({ data: { id: "org-2" }, error: null });
    expect(await switchOrganization("org-2")).toBe(true);
    expect(mocks.setActive).toHaveBeenCalledWith({ organizationId: "org-2" });
    expect(mocks.resetEditor).toHaveBeenCalledOnce();
    expect(mocks.invalidateFeatures).toHaveBeenCalledOnce();
    expect(mocks.refetchSidebar).toHaveBeenCalledWith({ orgChanged: true });
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });

  it("resolves false, and changes nothing, when the switch fails", async () => {
    mocks.setActive.mockResolvedValue({
      data: null,
      error: { message: "Forbidden", status: 403 },
    });
    expect(await switchOrganization("org-2")).toBe(false);
    expect(mocks.resetEditor).not.toHaveBeenCalled();
    expect(mocks.invalidateFeatures).not.toHaveBeenCalled();
    expect(mocks.refetchSidebar).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("opens the new org's last-edited visible workflow from a workflow", async () => {
    window.history.pushState({}, "", "/workflows/old");
    mocks.setActive.mockResolvedValue({ data: { id: "org-2" }, error: null });
    mocks.getAll.mockResolvedValue([
      { id: "older", name: "A", updatedAt: "2026-10-01T00:00:00Z" },
      { id: "edited", name: "B", updatedAt: "2026-10-02T00:00:00Z" },
      { id: "scratch", name: "__current__", updatedAt: "2026-10-03T00:00:00Z" },
      {
        id: "deleted",
        name: "C",
        updatedAt: "2026-10-04T00:00:00Z",
        deletedAt: "2026-10-05T00:00:00Z",
      },
    ]);
    expect(await switchOrganization("org-2")).toBe(true);
    expect(mocks.replace).toHaveBeenCalledWith("/workflows/edited");
  });

  it("goes home when the new org has no workflow to open", async () => {
    window.history.pushState({}, "", "/workflows/old");
    mocks.setActive.mockResolvedValue({ data: { id: "org-2" }, error: null });
    mocks.getAll.mockResolvedValue([
      { id: "scratch", name: "__current__", updatedAt: "2026-10-03T00:00:00Z" },
    ]);
    await switchOrganization("org-2");
    expect(mocks.replace).toHaveBeenCalledWith("/");
  });

  it("goes home when the new org's workflows cannot be listed", async () => {
    window.history.pushState({}, "", "/workflows/old");
    mocks.setActive.mockResolvedValue({ data: { id: "org-2" }, error: null });
    mocks.getAll.mockRejectedValue(new Error("offline"));
    expect(await switchOrganization("org-2")).toBe(true);
    expect(mocks.replace).toHaveBeenCalledWith("/");
  });

  it("acts on the page shown when it runs, not when it was set up", async () => {
    // Set up on a workflow, run after moving to another page (a retry).
    window.history.pushState({}, "", "/workflows/old");
    act(() => root.render(<Probe />));
    window.history.pushState({}, "", "/analytics");
    mocks.setActive.mockResolvedValue({ data: { id: "org-2" }, error: null });
    await switchOrganization("org-2");
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("switches from the page a caller names, when it is leaving the one shown", async () => {
    window.history.pushState({}, "", "/settings/org-1/organization");
    mocks.setActive.mockResolvedValue({ data: { id: "org-2" }, error: null });
    await switchOrganization("org-2", "/settings");
    // /settings has no org in its path: a plain refresh, not a rewrite of the
    // page shown.
    expect(mocks.push).not.toHaveBeenCalled();
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });

  it("treats a named workflow page as a workflow page", async () => {
    mocks.setActive.mockResolvedValue({ data: { id: "org-2" }, error: null });
    mocks.getAll.mockResolvedValue([
      { id: "edited", name: "B", updatedAt: "2026-10-02T00:00:00Z" },
    ]);
    await switchOrganization("org-2", "/workflows/x");
    expect(mocks.replace).toHaveBeenCalledWith("/workflows/edited");
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("resolves only once the new org is the one shown", async () => {
    let answer: () => void = () => undefined;
    mocks.refetchActive.mockImplementationOnce(() => {
      activeOrg.set({ ...activeOrg.get(), isRefetching: true });
      return new Promise<void>((resolve) => {
        answer = () => {
          activeOrg.set({
            data: { id: "org-2" },
            error: null,
            isPending: false,
            isRefetching: false,
          });
          resolve();
        };
      });
    });
    mocks.setActive.mockResolvedValue({ data: { id: "org-2" }, error: null });
    let settled = false;
    const switching = switchOrganization("org-2").then(() => {
      settled = true;
    });
    // The refresh is under way, not yet answered.
    await vi.waitFor(() => expect(mocks.refetchActive).toHaveBeenCalled());
    expect(settled).toBe(false);
    answer();
    await switching;
    expect(settled).toBe(true);
  });

  it("waits for the refresh the auth client starts itself, asking for none", async () => {
    // The org request has the auth client load the active org itself, a
    // few milliseconds after it answers (as better-auth does).
    mocks.setActive.mockImplementation(async () => {
      setTimeout(() => {
        refreshActive();
      }, 10);
      return { data: { id: "org-2" }, error: null };
    });
    expect(await switchOrganization("org-2")).toBe(true);
    // One load of the active org, not two.
    expect(mocks.refetchActive).not.toHaveBeenCalled();
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });

  it("asks again after a blip, and never loads the page afresh", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mocks.setActive.mockResolvedValue({ data: { id: "org-2" }, error: null });
      // The first refresh fails (a timeout): the page still shows org-1.
      mocks.shown = null;
      mocks.activeError = { status: 504 };
      const switching = switchOrganization("org-2");
      // No refresh of the auth client's own comes: one is asked for, and
      // fails.
      await vi.advanceTimersByTimeAsync(150);
      expect(mocks.refetchActive).toHaveBeenCalledOnce();
      // The next one answers.
      mocks.shown = "org-2";
      mocks.activeError = null;
      await vi.advanceTimersByTimeAsync(600);
      expect(await switching).toBe(true);
      expect(mocks.refetchActive).toHaveBeenCalledTimes(2);
      expect(activeOrg.get().data?.id).toBe("org-2");
      expect(mocks.resetEditor).toHaveBeenCalledOnce();
      expect(mocks.refresh).toHaveBeenCalledOnce();
      // It caught up: nothing to say.
      expect(mocks.toastError).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks again with its own request when the refresh hangs, within the limit", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      // The auth client's own refresh after setActive never answers.
      mocks.setActive.mockImplementation(async () => {
        setTimeout(() => {
          activeOrg.set({ ...activeOrg.get(), isRefetching: true });
        }, 10);
        return { data: { id: "org-2" }, error: null };
      });
      const switching = switchOrganization("org-2");
      // The first wait ends; the retry sends a request of its own.
      await vi.advanceTimersByTimeAsync(3200);
      expect(mocks.refetchActive).toHaveBeenCalledOnce();
      expect(await switching).toBe(true);
      expect(activeOrg.get().data?.id).toBe("org-2");
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends within the limit when every request hangs", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mocks.setActive.mockResolvedValue({ data: { id: "org-2" }, error: null });
      // Every refresh hangs.
      mocks.refetchActive.mockImplementation(() => {
        activeOrg.set({ ...activeOrg.get(), isRefetching: true });
        return new Promise(() => undefined);
      });
      let settled = false;
      const switching = switchOrganization("org-2").then((switched) => {
        settled = true;
        return switched;
      });
      await vi.advanceTimersByTimeAsync(8200);
      expect(settled).toBe(true);
      // The made switch is made; each retry sent its own request.
      expect(await switching).toBe(true);
      expect(mocks.refetchActive.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts a switch the server made as made, though the page could not show it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mocks.setActive.mockResolvedValue({ data: { id: "org-2" }, error: null });
      // Every refresh fails.
      mocks.shown = null;
      mocks.activeError = { status: 429 };
      const switching = switchOrganization("org-2", "/workflows/x");
      mocks.getAll.mockResolvedValue([
        { id: "edited", name: "B", updatedAt: "2026-10-02T00:00:00Z" },
      ]);
      await vi.advanceTimersByTimeAsync(3000);
      // Every request now runs as org-2: the switch is made, the editor
      // reset, and the page moved on in place (no fresh page load).
      expect(await switching).toBe(true);
      expect(mocks.refetchActive).toHaveBeenCalledTimes(3);
      expect(mocks.resetEditor).toHaveBeenCalledOnce();
      expect(mocks.replace).toHaveBeenCalledWith("/workflows/edited");
      // The page still shows the old org: the caller reads that from the
      // auth client and says so (the switch runner, with Reload).
      expect(activeOrg.get().data?.id).toBe("org-1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts only an error a retry can mend as failing to load", () => {
    const failedFor = (error: { status?: number } | null): boolean => {
      mocks.activeError = error;
      act(() => root.render(<Probe key={JSON.stringify(error)} />));
      return loadFailed;
    };
    try {
      // No answer, or the server's own error: there may be an org.
      expect(failedFor({})).toBe(true);
      expect(failedFor({ status: 500 })).toBe(true);
      expect(failedFor({ status: 503 })).toBe(true);
      // Too many requests, a timeout: they pass.
      expect(failedFor({ status: 429 })).toBe(true);
      expect(failedFor({ status: 408 })).toBe(true);
      // The org is gone, or the user was removed: none to load.
      expect(failedFor({ status: 400 })).toBe(false);
      expect(failedFor({ status: 403 })).toBe(false);
      expect(failedFor({ status: 404 })).toBe(false);
      expect(failedFor(null)).toBe(false);
      // As the auth client holds it now, for a load that has just answered.
      activeOrg.set({ ...activeOrg.get(), error: { status: 503 } });
      expect(activeOrgLoadFailed()).toBe(true);
      activeOrg.set({ ...activeOrg.get(), error: { status: 400 } });
      expect(activeOrgLoadFailed()).toBe(false);
    } finally {
      mocks.activeError = null;
    }
  });
});
