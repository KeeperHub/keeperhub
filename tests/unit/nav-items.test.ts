// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const { toastError, toastInfo, startNewWorkflow } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  startNewWorkflow: vi.fn(),
}));
vi.mock("@/lib/workflow/start-new-workflow", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/workflow/start-new-workflow")>()),
  startNewWorkflow,
}));
vi.mock("sonner", () => ({ toast: { error: toastError, info: toastInfo } }));

import {
  followNavItem,
  isNavItemActive,
  type NavItemDef,
  runNewWorkflow,
  SETTINGS_NAV_ITEM,
  visibleNavItems,
} from "@/components/nav-items";

describe("isNavItemActive", () => {
  it("matches a page item by its exact route", () => {
    expect(isNavItemActive("hub", "/hub")).toBe(true);
    expect(isNavItemActive("analytics", "/analytics")).toBe(true);
    expect(isNavItemActive("hub", "/hub/protocol")).toBe(false);
  });

  it("matches Workflows on the index and on any workflow", () => {
    expect(isNavItemActive("workflows", "/workflows")).toBe(true);
    expect(isNavItemActive("workflows", "/workflows/abc")).toBe(true);
    expect(isNavItemActive("workflows", "/workflowsx")).toBe(false);
  });

  it("matches Settings on /settings and anywhere under it", () => {
    expect(isNavItemActive("settings", "/settings")).toBe(true);
    expect(isNavItemActive("settings", "/settings/org-1/billing")).toBe(true);
    expect(isNavItemActive("settings", "/settingsx")).toBe(false);
  });

  it("never marks an item without a page", () => {
    expect(isNavItemActive("address-book", "/")).toBe(false);
    expect(isNavItemActive("unknown", "/hub")).toBe(false);
  });
});

function navItem(id: string): NavItemDef {
  const found = [...visibleNavItems(true, true), SETTINGS_NAV_ITEM].find(
    (item) => item.id === id
  );
  if (!found) {
    throw new Error(`no nav item ${id}`);
  }
  return found;
}

function handlers(isAnonymous: boolean) {
  return {
    isAnonymous,
    openAuthPrompt: vi.fn(),
    openWorkflows: vi.fn(),
    openAddressBook: vi.fn(),
    push: vi.fn(),
  };
}

describe("followNavItem", () => {
  it("asks a visitor to sign in for an account-only item", () => {
    const h = handlers(true);
    followNavItem(navItem("analytics"), h);
    expect(h.openAuthPrompt).toHaveBeenCalledWith({
      action: "nav:analytics",
      redirectTo: "/analytics",
    });
    expect(h.push).not.toHaveBeenCalled();
  });

  it("asks to sign in without a redirect for an account-only item with no page", () => {
    const h = handlers(true);
    followNavItem(navItem("address-book"), h);
    expect(h.openAuthPrompt).toHaveBeenCalledWith({
      action: "nav:address-book",
      redirectTo: undefined,
    });
    expect(h.openAddressBook).not.toHaveBeenCalled();
  });

  it("lets a visitor open a public item", () => {
    const h = handlers(true);
    followNavItem(navItem("hub"), h);
    expect(h.push).toHaveBeenCalledWith("/hub");
    expect(h.openAuthPrompt).not.toHaveBeenCalled();
  });

  it("leaves Workflows to the caller", () => {
    const h = handlers(false);
    followNavItem(navItem("workflows"), h);
    expect(h.openWorkflows).toHaveBeenCalledOnce();
    expect(h.push).not.toHaveBeenCalled();
  });

  it("opens the address book in place", () => {
    const h = handlers(false);
    followNavItem(navItem("address-book"), h);
    expect(h.openAddressBook).toHaveBeenCalledOnce();
    expect(h.push).not.toHaveBeenCalled();
  });

  it("goes to an item's page for a signed-in user", () => {
    const h = handlers(false);
    followNavItem(SETTINGS_NAV_ITEM, h);
    expect(h.push).toHaveBeenCalledWith("/settings");
  });
});

describe("runNewWorkflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function run(overrides: { onCreated?: (id: string) => void } = {}) {
    const push = vi.fn();
    const onSettled = vi.fn();
    const onCreated = vi.fn(overrides.onCreated);
    const done = runNewWorkflow({
      isAnonymous: false,
      hasSession: true,
      push,
      onSettled,
      onCreated,
    });
    return { done, push, onSettled, onCreated };
  }

  it("hands a new workflow on, once settled", async () => {
    startNewWorkflow.mockResolvedValueOnce({ id: "wf-1", created: true });
    const { done, push, onSettled, onCreated } = run();
    await done;
    expect(onSettled).toHaveBeenCalledOnce();
    expect(onCreated).toHaveBeenCalledWith("wf-1");
    expect(push).not.toHaveBeenCalled();
  });

  it("tells an anonymous visitor why, and opens their one workflow", async () => {
    startNewWorkflow.mockResolvedValueOnce({ id: "wf-1", created: false });
    const { done, push, onCreated } = run();
    await done;
    expect(toastInfo).toHaveBeenCalledWith("Sign in to create more workflows.");
    expect(push).toHaveBeenCalledWith("/workflows/wf-1");
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("says a workflow could not be made, logs why, and goes home", async () => {
    const error = new Error("offline");
    startNewWorkflow.mockRejectedValueOnce(error);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { done, push, onSettled } = run();
      await done;
      expect(toastError).toHaveBeenCalledWith("Failed to create workflow");
      expect(log).toHaveBeenCalledWith(expect.any(String), error);
      expect(push).toHaveBeenCalledWith("/");
      expect(onSettled).toHaveBeenCalledOnce();
    } finally {
      log.mockRestore();
    }
  });

  it("does not report a workflow it made when what follows throws", async () => {
    startNewWorkflow.mockResolvedValueOnce({ id: "wf-1", created: true });
    const { done } = run({
      onCreated: () => {
        throw new Error("after");
      },
    });
    await expect(done).rejects.toThrow("after");
    expect(toastError).not.toHaveBeenCalled();
  });
});
