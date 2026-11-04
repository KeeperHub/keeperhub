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
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  unmount();
  container.remove();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.useRealTimers();
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

  it("lets navigation within the page and a clean form through", () => {
    installHistory(["/settings/org-1/alerts"]);
    render(true);
    act(() => guarded.push("/settings/org-1/alerts?highlight=methods"));
    expect(dialogOpen()).toBe(false);
    expect(entries.map((e) => e.url)).toEqual([
      "/settings/org-1/alerts",
      "/settings/org-1/alerts?highlight=methods",
    ]);
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

  it("Back then Leave goes to the page before", async () => {
    installHistory(["/workflows", "/settings/org-1/alerts"]);
    render(true);
    act(() => window.history.back());
    expect(dialogOpen()).toBe(true);
    // Back was held on the page.
    expect(index).toBe(2);

    await choose("Leave");
    expect(paths()[index]).toBe("/workflows");
    act(() => vi.advanceTimersByTime(1000));
    expect(baseRouter.replace).not.toHaveBeenCalled();
  });

  it("Back then Leave with no earlier page goes to the fallback and keeps guarding", async () => {
    installHistory(["/settings/org-1/alerts"]);
    render(true);
    act(() => window.history.back());
    await choose("Leave");
    // History could not move two back.
    expect(index).toBe(1);

    act(() => vi.advanceTimersByTime(1000));
    expect(paths()).toEqual(["/settings/org-1/alerts", "/settings/org-1"]);
    expect(index).toBe(1);

    // Not stuck leaving: a later navigation is asked about again.
    realReplace.call(window.history, null, "", "/settings/org-1/alerts");
    act(() => guarded.push("/analytics"));
    expect(dialogOpen()).toBe(true);
  });

  it("does not prompt on unload once Leave was chosen", async () => {
    installHistory(["/settings/org-1/alerts"]);
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

  it("confirmLeave asks first and Stay resolves false", async () => {
    installHistory(["/settings/org-1/alerts"]);
    await expect(confirmLeave("/workflows")).resolves.toBe(true);

    render(true);
    let answer: boolean | undefined;
    act(() => {
      confirmLeave("/workflows")
        .then((leave) => {
          answer = leave;
        })
        .catch(() => undefined);
    });
    expect(dialogOpen()).toBe(true);
    await choose("Stay");
    expect(answer).toBe(false);
    expect(index).toBe(1);
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
