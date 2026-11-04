// @vitest-environment jsdom
import type { AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Entry = { url: string; state: Record<string, unknown> | null };

// A modelled session history, so tests read where history ends up.
let entries: Entry[] = [];
let index = 0;
const realReplace = History.prototype.replaceState;

function show(): void {
  realReplace.call(
    window.history,
    entries[index].state,
    "",
    entries[index].url
  );
}

function installHistory(urls: string[]): void {
  entries = urls.map((url) => ({ url, state: null }));
  index = entries.length - 1;
  show();
  vi.spyOn(window.history, "pushState").mockImplementation(
    (state, _title, url) => {
      entries = entries.slice(0, index + 1);
      entries.push({ url: String(url), state });
      index += 1;
      show();
    }
  );
  vi.spyOn(window.history, "replaceState").mockImplementation(
    (state, _title, url) => {
      entries[index] = { url: String(url), state };
      show();
    }
  );
  vi.spyOn(window.history, "go").mockImplementation((delta = 0) => {
    const target = index + delta;
    if (target < 0 || target >= entries.length) {
      return;
    }
    index = target;
    show();
    window.dispatchEvent(
      new PopStateEvent("popstate", { state: entries[index].state })
    );
  });
  vi.spyOn(window.history, "back").mockImplementation(() =>
    window.history.go(-1)
  );
  vi.spyOn(window.history, "length", "get").mockImplementation(
    () => entries.length
  );
}

const paths = (): string[] =>
  entries.map((e) => new URL(e.url, window.location.origin).pathname);

// Next's router writes its own history state, as push and replace do here.
const baseRouter = {
  back: vi.fn(),
  forward: vi.fn(),
  refresh: vi.fn(),
  prefetch: vi.fn(),
  push: vi.fn((href: string) => window.history.pushState({}, "", href)),
  replace: vi.fn((href: string) => window.history.replaceState({}, "", href)),
} as unknown as AppRouterInstance;

vi.mock("next/navigation", () => ({
  useRouter: () => guarded,
}));

import { UnsavedChangesGuard } from "@/components/failure-alerts/unsaved-guard";
import { confirmLeave, guardRouter } from "@/components/navigation-guard";
import { runOrgSwitch } from "@/components/organization/org-switch-runner";

const guarded = guardRouter(baseRouter);

let container: HTMLDivElement;
let root: Root;
let mounted = false;

const dialogOpen = (): boolean =>
  document.querySelector('[data-testid="failure-alerts-unsaved-dialog"]') !==
  null;

function button(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll("button")].find(
    (b) => b.textContent === label
  );
}

async function choose(label: "Leave" | "Stay"): Promise<void> {
  await act(async () => {
    button(label)?.click();
    await Promise.resolve();
  });
}

function render(dirty: boolean): void {
  act(() =>
    root.render(
      <UnsavedChangesGuard backFallback="/settings/org-1" dirty={dirty} />
    )
  );
  mounted = true;
}

function unmount(): void {
  if (mounted) {
    act(() => root.unmount());
    mounted = false;
  }
}

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  unmount();
  container.remove();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("UnsavedChangesGuard", () => {
  it("asks before a router push, and Leave takes the guard entry's place", async () => {
    installHistory(["/workflows", "/settings/org-1/alerts"]);
    render(true);
    expect(paths()).toEqual([
      "/workflows",
      "/settings/org-1/alerts",
      "/settings/org-1/alerts",
    ]);

    act(() => guarded.push("/analytics"));
    expect(baseRouter.push).not.toHaveBeenCalled();
    expect(dialogOpen()).toBe(true);

    await choose("Leave");
    unmount();
    expect(paths()).toEqual([
      "/workflows",
      "/settings/org-1/alerts",
      "/analytics",
    ]);
    expect(index).toBe(2);
  });

  it("asks before a link click; Stay changes nothing", async () => {
    installHistory(["/settings/org-1/alerts"]);
    render(true);
    const link = document.createElement("a");
    link.href = "/analytics";
    document.body.appendChild(link);

    act(() => link.click());
    expect(dialogOpen()).toBe(true);
    await choose("Stay");
    expect(dialogOpen()).toBe(false);
    expect(paths()).toEqual([
      "/settings/org-1/alerts",
      "/settings/org-1/alerts",
    ]);
    expect(index).toBe(1);
    link.remove();
  });

  it("keeps a same-page push a push, and Back from it stays without asking", () => {
    installHistory(["/settings/org-1/alerts"]);
    render(true);
    act(() => guarded.push("/settings/org-1/alerts?highlight=methods"));
    expect(dialogOpen()).toBe(false);
    expect(paths()).toEqual([
      "/settings/org-1/alerts",
      "/settings/org-1/alerts",
      "/settings/org-1/alerts",
    ]);
    expect(entries[2].url).toBe("/settings/org-1/alerts?highlight=methods");
    act(() => window.history.back());
    expect(dialogOpen()).toBe(false);
    expect(index).toBe(1);
    expect(entries).toHaveLength(3);
  });

  it("drops the guard entry once saved, then lets navigation through", () => {
    installHistory(["/settings/org-1/alerts"]);
    render(true);
    expect(index).toBe(1);
    render(false);
    expect(index).toBe(0);
    act(() => guarded.push("/workflows/w1"));
    expect(baseRouter.push).toHaveBeenCalledTimes(1);
    expect(dialogOpen()).toBe(false);
  });

  it("Back then Leave goes to the page before (history length 3)", async () => {
    installHistory(["/workflows", "/settings/org-1/alerts"]);
    render(true);
    act(() => window.history.back());
    expect(dialogOpen()).toBe(true);
    // Back was held on the page.
    expect(index).toBe(2);
    expect(window.history.length).toBe(3);

    await choose("Leave");
    expect(paths()[index]).toBe("/workflows");
    expect(index).toBe(0);
    expect(baseRouter.replace).not.toHaveBeenCalled();
  });

  it("Back then Leave with no earlier page (history length 2) goes to the fallback and keeps guarding", async () => {
    installHistory(["/settings/org-1/alerts"]);
    render(true);
    act(() => window.history.back());
    expect(window.history.length).toBe(2);
    await choose("Leave");
    expect(window.history.go).not.toHaveBeenCalledWith(-2);
    expect(paths()).toEqual(["/settings/org-1/alerts", "/settings/org-1"]);
    expect(index).toBe(1);

    // Not stuck leaving: a later navigation is asked about again.
    realReplace.call(window.history, null, "", "/settings/org-1/alerts");
    act(() => guarded.push("/analytics"));
    expect(dialogOpen()).toBe(true);
  });

  it("does not prompt on unload once Leave was chosen", async () => {
    // Back then Leave goes to a page off the app.
    installHistory(["/elsewhere", "/settings/org-1/alerts"]);
    render(true);
    const before = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(before);
    expect(before.defaultPrevented).toBe(true);

    act(() => window.history.back());
    await choose("Leave");
    const after = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });

  it("confirmLeave runs at once when nobody asks; Stay runs nothing", async () => {
    installHistory(["/settings/org-1/alerts"]);
    const proceed = vi.fn(() => "went");
    const first = confirmLeave("/workflows", proceed);
    // Synchronous, so callers keep their timing.
    expect(proceed).toHaveBeenCalledTimes(1);
    await expect(first).resolves.toBe("went");

    render(true);
    let answer: string | null | undefined;
    act(() => {
      confirmLeave("/workflows", proceed)
        .then((result) => {
          answer = result;
        })
        .catch(() => undefined);
    });
    expect(dialogOpen()).toBe(true);
    await choose("Stay");
    expect(answer).toBeNull();
    expect(proceed).toHaveBeenCalledTimes(1);
    expect(index).toBe(1);
  });

  it("Leave for an action that stays on the same path leaves no dead Back", async () => {
    installHistory(["/workflows", "/settings/org-1/alerts"]);
    render(true);
    const start = vi.fn(() => Promise.resolve(true));
    act(() => {
      runOrgSwitch({
        orgId: "org-4",
        name: "Same",
        start,
        announce: false,
      }).catch(() => undefined);
    });
    await choose("Leave");
    await act(async () => {
      await Promise.resolve();
    });
    expect(start).toHaveBeenCalledTimes(1);
    // The page reloads clean for the new org.
    render(false);
    unmount();
    // Back goes straight to the page before.
    expect(index).toBe(1);
    expect(entries[index].state?.__leaveGuard).toBeUndefined();
    expect(paths()[index - 1]).toBe("/workflows");
  });

  it("an org switch asks first; Leave switches without an extra entry", async () => {
    installHistory(["/workflows", "/settings/org-1/alerts"]);
    render(true);
    const start = vi.fn(() => {
      guarded.push("/settings/org-2/alerts");
      return Promise.resolve(true);
    });
    act(() => {
      runOrgSwitch({
        orgId: "org-3",
        name: "Other",
        start,
        announce: false,
      }).catch(() => undefined);
    });
    expect(start).not.toHaveBeenCalled();
    await choose("Leave");
    await act(async () => {
      await Promise.resolve();
    });
    expect(start).toHaveBeenCalledTimes(1);
    unmount();
    expect(paths()).toEqual([
      "/workflows",
      "/settings/org-1/alerts",
      "/settings/org-2/alerts",
    ]);
  });

  it("re-arms when the org switch after Leave fails", async () => {
    installHistory(["/workflows", "/settings/org-1/alerts"]);
    render(true);
    const start = vi.fn(() => Promise.resolve(false));
    act(() => {
      runOrgSwitch({
        orgId: "org-5",
        name: "Broken",
        start,
        announce: false,
      }).catch(() => undefined);
    });
    await choose("Leave");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(start).toHaveBeenCalledTimes(1);
    // Still here, with the guard entry back on top for Back to land on.
    expect(paths()).toEqual([
      "/workflows",
      "/settings/org-1/alerts",
      "/settings/org-1/alerts",
    ]);
    expect(index).toBe(2);
    expect(entries[2].state?.__leaveGuard).toBe(true);
    act(() => guarded.push("/analytics"));
    expect(dialogOpen()).toBe(true);
    expect(baseRouter.push).not.toHaveBeenCalled();
  });

  it("re-arms when the action after Leave throws, and a later Leave still works", async () => {
    installHistory(["/workflows", "/settings/org-1/alerts"]);
    render(true);
    let failed: unknown;
    act(() => {
      confirmLeave("/workflows", () => {
        throw new Error("create failed");
      }).catch((error: unknown) => {
        failed = error;
      });
    });
    await choose("Leave");
    await act(async () => {
      await Promise.resolve();
    });
    expect(failed).toBeInstanceOf(Error);
    expect(index).toBe(2);
    expect(entries).toHaveLength(3);

    act(() => guarded.push("/analytics"));
    await choose("Leave");
    unmount();
    expect(paths()).toEqual([
      "/workflows",
      "/settings/org-1/alerts",
      "/analytics",
    ]);
  });

  it("tells the action Leave was asked, so New Workflow can stay on failure", async () => {
    installHistory(["/settings/org-1/alerts"]);
    const proceed = vi.fn((asked: boolean) => !asked);
    await expect(confirmLeave("/workflows", proceed)).resolves.toBe(true);
    expect(proceed).toHaveBeenLastCalledWith(false);

    render(true);
    act(() => {
      confirmLeave("/workflows", proceed).catch(() => undefined);
    });
    await choose("Leave");
    await act(async () => {
      await Promise.resolve();
    });
    expect(proceed).toHaveBeenLastCalledWith(true);
    // Resolved false: not left, so guarded again.
    expect(paths()).toEqual([
      "/settings/org-1/alerts",
      "/settings/org-1/alerts",
    ]);
    expect(index).toBe(1);
  });

  it("reuses the guard entry after a reload on it", () => {
    installHistory(["/workflows", "/settings/org-1/alerts"]);
    // A reload keeps the entry's state: the shown entry is already the copy.
    entries.push({
      url: "/settings/org-1/alerts",
      state: { __leaveGuard: true },
    });
    index = 2;
    show();
    render(true);
    expect(entries).toHaveLength(3);
    expect(index).toBe(2);
    render(false);
    // Saved: the one copy is dropped, nothing dead is left.
    expect(index).toBe(1);
    expect(entries[1].state?.__leaveGuard).toBeUndefined();
  });

  it("an org switch asks first; Stay does not start it", async () => {
    installHistory(["/settings/org-1/alerts"]);
    render(true);
    const start = vi.fn(() => Promise.resolve(true));
    let result: boolean | null | undefined;
    act(() => {
      runOrgSwitch({ orgId: "org-2", name: "Other", start, announce: false })
        .then((ran) => {
          result = ran;
        })
        .catch(() => undefined);
    });
    expect(dialogOpen()).toBe(true);
    await choose("Stay");
    expect(result).toBeNull();
    expect(start).not.toHaveBeenCalled();
  });
});
