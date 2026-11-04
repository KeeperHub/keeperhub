// @vitest-environment jsdom
import type { AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const routerPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush }),
}));

import {
  guardRouter,
  UnsavedChangesGuard,
} from "@/components/failure-alerts/unsaved-guard";

let container: HTMLDivElement;
let root: Root;

function fakeRouter(): AppRouterInstance {
  return {
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
    push: vi.fn(),
    replace: vi.fn(),
  } as unknown as AppRouterInstance;
}

const dialogOpen = (): boolean =>
  document.querySelector('[data-testid="failure-alerts-unsaved-dialog"]') !==
  null;

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  window.history.replaceState(null, "", "/settings/org-1/alerts");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("UnsavedChangesGuard", () => {
  it("asks before a router navigation to another page, and goes on Leave", () => {
    const router = fakeRouter();
    const guarded = guardRouter(router);
    act(() => root.render(<UnsavedChangesGuard dirty />));

    act(() => guarded.push("/workflows/w1"));
    expect(router.push).not.toHaveBeenCalled();
    expect(dialogOpen()).toBe(true);

    const leave = [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "Leave"
    );
    act(() => leave?.click());
    expect(router.push).toHaveBeenCalledWith("/workflows/w1", undefined);
  });

  it("lets navigation within the page and a clean form through", () => {
    const router = fakeRouter();
    const guarded = guardRouter(router);
    act(() => root.render(<UnsavedChangesGuard dirty />));
    act(() => guarded.replace("/settings/org-1/alerts?highlight=methods"));
    expect(router.replace).toHaveBeenCalledTimes(1);

    act(() => root.render(<UnsavedChangesGuard dirty={false} />));
    act(() => guarded.push("/workflows/w1"));
    expect(router.push).toHaveBeenCalledTimes(1);
  });

  it("holds Back on the page and asks", () => {
    const pushState = vi.spyOn(window.history, "pushState");
    act(() => root.render(<UnsavedChangesGuard dirty />));
    // A copy of the page is pushed for Back to land on.
    expect(pushState).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    });
    expect(pushState).toHaveBeenCalledTimes(2);
    expect(dialogOpen()).toBe(true);
    pushState.mockRestore();
  });
});
