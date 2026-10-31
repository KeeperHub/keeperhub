// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  openAuthPrompt: vi.fn(),
  openOverlay: vi.fn(),
  startNewWorkflow: vi.fn(),
  refetchSidebar: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  session: { data: null as unknown, isPending: false },
  member: { isAdmin: false, isOwner: false },
  isMobile: true,
  pathname: "/hub",
  params: {} as Record<string, string>,
  picker: null as unknown,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
  usePathname: () => mocks.pathname,
  useParams: () => mocks.params,
}));
vi.mock("@/components/workflow-picker-data", () => ({
  usePickerData: () => mocks.picker,
}));
vi.mock("@/components/auth/provider", () => ({
  useAuthPrompt: () => ({ openAuthPrompt: mocks.openAuthPrompt }),
}));
vi.mock("@/components/overlays/overlay-provider", () => ({
  useOverlay: () => ({ open: mocks.openOverlay }),
}));
vi.mock("@/components/overlays/address-book-overlay", () => ({
  AddressBookOverlay(): null {
    return null;
  },
}));
vi.mock("@/lib/auth-client", () => ({
  useSession: () => mocks.session,
}));
vi.mock("@/lib/hooks/use-organization", () => ({
  currentActiveOrgId: () => undefined,
  useActiveMember: () => mocks.member,
}));
vi.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => mocks.isMobile,
}));
vi.mock("@/lib/refetch-sidebar", () => ({
  refetchSidebar: mocks.refetchSidebar,
}));
vi.mock("@/lib/workflow/start-new-workflow", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/workflow/start-new-workflow")>()),
  startNewWorkflow: mocks.startNewWorkflow,
}));
vi.mock("sonner", () => ({
  toast: { error: mocks.toastError, info: mocks.toastInfo },
}));
vi.mock("@/lib/workflow/editor/extension-registry", () => ({
  getCustomLogo: () => null,
}));
// Stands in for the org switcher: a tap switches to another organization.
vi.mock("@/components/organization/org-switcher", () => ({
  OrgSwitcher({ menu }: { menu?: OrgSwitcherMenu }): React.ReactNode {
    return (
      <button
        data-testid="mobile-nav-org-switcher"
        disabled={menu?.disabled}
        onClick={() => menu?.onPick(true)}
        type="button"
      >
        Acme Labs
      </button>
    );
  },
}));

import { MobileNav } from "@/components/mobile-nav";
import type { OrgSwitcherMenu } from "@/components/organization/org-switcher";
import type { WorkflowEntry } from "@/components/workflow-picker-list";
import type { Project } from "@/lib/api-client";

const signedIn = {
  data: { user: { name: "Dana", email: "dana@example.com" } },
  isPending: false,
};
const signedOut = { data: null, isPending: false };
const anonymous = {
  data: {
    user: {
      name: "Guest",
      email: "temp@http://localhost:3000",
      isAnonymous: true,
    },
  },
  isPending: false,
};

function project(id: string, name: string): Project {
  return { id, name, color: "#98C379" } as Project;
}

function entry(
  id: string,
  name: string,
  projectId: string | null = null
): WorkflowEntry {
  return {
    id,
    name,
    projectId,
    updatedAt: "2026-10-01T00:00:00.000Z",
    triggerType: "Schedule",
    triggerConfig: { scheduleCron: "*/5 * * * *" },
    enabled: true,
  };
}

// One project with two workflows, and one workflow outside any project.
function pickerData(
  overrides: Partial<{
    loading: boolean;
    projectsLoading: boolean;
    projects: Project[];
  }> = {}
): unknown {
  const workflows = [
    entry("wf-a", "Relayer balance", "p-1"),
    entry("wf-b", "Challenger bot", "p-1"),
    entry("wf-c", "Loose monitor"),
  ];
  return {
    workflows,
    byProject: { "p-1": workflows.slice(0, 2) },
    ungrouped: workflows.slice(2),
    projects: [project("p-1", "Chronicle")],
    tags: [],
    loading: false,
    projectsLoading: false,
    refetch: vi.fn(),
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;
// What performance.now() returns; taps move it.
let clock = 0;

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// Stands in for whatever may take focus after a pick (the sign-in prompt
// does; a page change may leave it on the page itself). The drawer's part
// is only not to pull focus back to its button, which the stand-in shows:
// had the drawer sent focus back, the button would hold it, not this.
let landing: HTMLButtonElement;

function focusLanding(): void {
  setTimeout(() => landing.focus(), 0);
}

beforeEach(() => {
  vi.clearAllMocks();
  landing = document.createElement("button");
  document.body.appendChild(landing);
  mocks.push.mockImplementation(focusLanding);
  mocks.openOverlay.mockImplementation(focusLanding);
  mocks.openAuthPrompt.mockImplementation(focusLanding);
  mocks.session = signedIn;
  mocks.member = { isAdmin: false, isOwner: false };
  mocks.isMobile = true;
  mocks.pathname = "/hub";
  mocks.params = {};
  mocks.picker = pickerData();
  clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  // Radix measures a row tooltip's trigger with an observer jsdom lacks.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {
        // jsdom does no layout
      }
      unobserve(): void {
        // jsdom does no layout
      }
      disconnect(): void {
        // jsdom does no layout
      }
    }
  );
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  landing.remove();
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function render(): void {
  act(() => root.render(<MobileNav />));
}

// Radix moves focus on close from a zero-delay timer once the drawer is gone.
async function settleFocus(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function trigger(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(
    "[data-testid=mobile-nav-trigger]"
  );
}

function openDrawer(): void {
  act(() => {
    document
      .querySelector<HTMLButtonElement>("[data-testid=mobile-nav-trigger]")
      ?.click();
  });
}

function drawer(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-testid=mobile-nav]");
}

function isOpen(): boolean {
  return (
    document
      .querySelector("[data-testid=mobile-nav-trigger]")
      ?.getAttribute("aria-expanded") === "true"
  );
}

function newButton(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(
    "[data-testid=mobile-nav-new]"
  );
}

function item(id: string): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(
    `[data-testid=mobile-nav-${id}]`
  );
}

function levelTitle(): string | null | undefined {
  return document.querySelector("[data-testid=mobile-nav-level-title]")
    ?.textContent;
}

function rows(): HTMLButtonElement[] {
  return [
    ...document.querySelectorAll<HTMLButtonElement>(
      "[data-testid=workflow-picker-item]"
    ),
  ];
}

function projectRow(id: string): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(
    `[data-testid=workflow-picker-project][data-project-id="${id}"]`
  );
}

// A tap pressed at `at` (the press's timeStamp) and handled at `handledAt`
// (performance.now() then; a busy phone handles it late): a pointerdown, then
// a pointer click (detail 1). element.click() is a key press's (detail 0).
function tap(element: HTMLElement | null, at: number, handledAt = at): void {
  if (!element) {
    throw new Error("element not found");
  }
  clock = handledAt;
  const press = new Event("pointerdown", { bubbles: true, cancelable: true });
  Object.defineProperty(press, "timeStamp", { value: at });
  const click = new MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    detail: 1,
  });
  act(() => {
    element.dispatchEvent(press);
    element.dispatchEvent(click);
  });
}

function back(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(
    "[data-testid=mobile-nav-back]"
  );
}

function pressEscape(): void {
  act(() => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      })
    );
  });
}

function orgSwitcher(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(
    "[data-testid=mobile-nav-org-switcher]"
  );
}

function click(element: HTMLElement | null): void {
  if (!element) {
    throw new Error("element not found");
  }
  act(() => element.click());
}

describe("MobileNav", () => {
  it("renders nothing of the drawer until it is opened", () => {
    render();
    expect(drawer()).toBeNull();
    openDrawer();
    expect(drawer()).not.toBeNull();
    expect(item("hub")).not.toBeNull();
    expect(item("settings")).not.toBeNull();
  });

  it("marks the current page", () => {
    render();
    openDrawer();
    expect(item("hub")?.getAttribute("aria-current")).toBe("page");
    expect(item("analytics")?.hasAttribute("aria-current")).toBe(false);
  });

  it("navigates and closes on a pick", () => {
    render();
    openDrawer();
    click(item("analytics"));
    expect(mocks.push).toHaveBeenCalledWith("/analytics");
    expect(isOpen()).toBe(false);
  });

  it("opens the settings menu from inside a settings section", () => {
    mocks.pathname = "/settings/org-1/users";
    render();
    openDrawer();
    click(item("settings"));
    expect(mocks.push).toHaveBeenCalledWith("/settings");
    expect(isOpen()).toBe(false);
  });

  it("only closes for Settings on the settings menu itself", () => {
    mocks.pathname = "/settings";
    render();
    openDrawer();
    click(item("settings"));
    expect(mocks.push).not.toHaveBeenCalled();
    expect(isOpen()).toBe(false);
  });

  it("opens Workflows inside the drawer: projects, then the rest", () => {
    render();
    openDrawer();
    click(item("workflows"));
    expect(mocks.push).not.toHaveBeenCalled();
    expect(isOpen()).toBe(true);
    expect(levelTitle()).toBe("Workflows");
    expect(projectRow("p-1")?.textContent).toContain("Chronicle");
    expect(rows().map((r) => r.textContent)).toEqual([
      expect.stringContaining("Loose monitor"),
    ]);
  });
  it("opens the address book overlay", () => {
    render();
    openDrawer();
    click(item("address-book"));
    expect(mocks.openOverlay).toHaveBeenCalledOnce();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("asks a signed-out visitor to sign in for an account-only item", () => {
    mocks.session = signedOut;
    render();
    openDrawer();
    click(item("analytics"));
    expect(mocks.openAuthPrompt).toHaveBeenCalledWith({
      action: "nav:analytics",
      redirectTo: "/analytics",
    });
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("lets a signed-out visitor open a public item", () => {
    mocks.session = signedOut;
    mocks.pathname = "/activity";
    render();
    openDrawer();
    click(item("hub"));
    expect(mocks.push).toHaveBeenCalledWith("/hub");
    expect(mocks.openAuthPrompt).not.toHaveBeenCalled();
  });

  it("asks a signed-out visitor to sign in for Workflows", () => {
    mocks.session = signedOut;
    render();
    openDrawer();
    click(item("workflows"));
    expect(mocks.openAuthPrompt).toHaveBeenCalledWith({
      action: "nav:workflows",
      redirectTo: "/workflows?latest=edited",
    });
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("waits for the session before anything can be picked", () => {
    mocks.session = { data: null, isPending: true };
    render();
    openDrawer();
    expect(item("analytics")?.disabled).toBe(true);
    expect(newButton()?.disabled).toBe(true);
  });

  it("marks Settings on any settings page", () => {
    mocks.pathname = "/settings/org-1/billing";
    render();
    openDrawer();
    expect(item("settings")?.getAttribute("aria-current")).toBe("page");
    expect(item("hub")?.hasAttribute("aria-current")).toBe(false);
  });

  it("shows owner-only items to owners only", () => {
    render();
    openDrawer();
    expect(item("held-payments")).toBeNull();
    act(() => root.unmount());
    root = createRoot(container);
    mocks.member = { isAdmin: true, isOwner: true };
    render();
    openDrawer();
    expect(item("held-payments")).not.toBeNull();
  });

  it("creates a workflow, refreshes the sidebar and opens it", async () => {
    mocks.startNewWorkflow.mockResolvedValue({ id: "wf-1", created: true });
    render();
    openDrawer();
    await act(async () => {
      newButton()?.click();
      await Promise.resolve();
    });
    expect(mocks.startNewWorkflow).toHaveBeenCalledWith({
      isAnonymous: false,
      hasSession: true,
    });
    expect(mocks.refetchSidebar).toHaveBeenCalledWith({
      workflowCreated: true,
    });
    expect(mocks.push).toHaveBeenCalledWith("/workflows/wf-1");
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("opens an anonymous visitor's one workflow without a refresh", async () => {
    mocks.session = signedOut;
    mocks.startNewWorkflow.mockResolvedValue({ id: "only", created: false });
    render();
    openDrawer();
    await act(async () => {
      newButton()?.click();
      await Promise.resolve();
    });
    expect(mocks.startNewWorkflow).toHaveBeenCalledWith({
      isAnonymous: true,
      hasSession: false,
    });
    expect(mocks.refetchSidebar).not.toHaveBeenCalled();
    // Told why nothing new was made.
    expect(mocks.toastInfo).toHaveBeenCalledWith(
      "Sign in to create more workflows."
    );
    expect(mocks.push).toHaveBeenCalledWith("/workflows/only");
  });

  it("keeps New Workflow busy when the drawer is closed and reopened mid-create", async () => {
    let finish: (value: { id: string; created: boolean }) => void = () => {
      // replaced below
    };
    mocks.startNewWorkflow.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    render();
    openDrawer();
    click(newButton());
    // Dismissed with Escape while the workflow is still being created.
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
    });
    expect(isOpen()).toBe(false);
    openDrawer();
    expect(newButton()?.disabled).toBe(true);
    click(newButton());
    expect(mocks.startNewWorkflow).toHaveBeenCalledOnce();
    await act(async () => {
      finish({ id: "wf-1", created: true });
      await Promise.resolve();
    });
    expect(mocks.push).toHaveBeenCalledWith("/workflows/wf-1");
  });

  it("closes for the page already shown without navigating", () => {
    render();
    openDrawer();
    click(item("hub"));
    expect(mocks.push).not.toHaveBeenCalled();
    expect(isOpen()).toBe(false);
  });

  it("opens on the open workflow's project, which the menu names", () => {
    mocks.pathname = "/workflows/wf-a";
    mocks.params = { workflowId: "wf-a" };
    render();
    openDrawer();
    expect(item("workflows")?.textContent).toContain("Chronicle");
    expect(item("workflows")?.getAttribute("aria-label")).toBe(
      "Workflows, Chronicle, opens a list"
    );
    click(item("workflows"));
    expect(levelTitle()).toBe("Chronicle");
    expect(rows().map((r) => r.getAttribute("aria-current"))).toEqual([
      "page",
      null,
    ]);
  });
  it("asks a visitor on a shared workflow to sign in for Workflows", () => {
    mocks.session = signedOut;
    mocks.pathname = "/workflows/shared";
    render();
    openDrawer();
    click(item("workflows"));
    expect(mocks.openAuthPrompt).toHaveBeenCalledWith({
      action: "nav:workflows",
      redirectTo: "/workflows?latest=edited",
    });
  });

  it("opens a project from the list, and back goes up a level at a time", async () => {
    render();
    openDrawer();
    click(item("workflows"));
    click(projectRow("p-1"));
    expect(levelTitle()).toBe("Chronicle");
    await settleFocus();
    expect(document.activeElement?.getAttribute("data-testid")).toBe(
      "mobile-nav-level-title"
    );
    click(back());
    expect(levelTitle()).toBe("Workflows");
    expect(document.activeElement).toBe(projectRow("p-1"));
    click(back());
    expect(levelTitle()).toBeUndefined();
    expect(document.activeElement).toBe(item("workflows"));
    expect(isOpen()).toBe(true);
  });

  it("goes up a level on Escape, and closes from the menu", () => {
    mocks.params = { workflowId: "wf-a" };
    render();
    openDrawer();
    click(item("workflows"));
    pressEscape();
    expect(levelTitle()).toBe("Workflows");
    pressEscape();
    expect(item("workflows")).not.toBeNull();
    expect(isOpen()).toBe(true);
    pressEscape();
    expect(isOpen()).toBe(false);
  });

  it("lets the filter button use an Escape before the level does", () => {
    render();
    openDrawer();
    click(item("workflows"));
    const filterButton = document.querySelector<HTMLButtonElement>(
      "[data-testid=trigger-filter-button]"
    );
    click(filterButton);
    expect(
      document.querySelector("[data-testid=trigger-filters]")
    ).not.toBeNull();
    // Escape on a menu button, with its menu shut, hides the unused row.
    document
      .querySelector<HTMLButtonElement>("[data-testid=status-filter]")
      ?.focus();
    pressEscape();
    expect(document.querySelector("[data-testid=trigger-filters]")).toBeNull();
    expect(levelTitle()).toBe("Workflows");
    pressEscape();
    expect(item("workflows")).not.toBeNull();
  });

  it("starts from the menu each time it opens", () => {
    mocks.params = { workflowId: "wf-a" };
    render();
    openDrawer();
    click(item("workflows"));
    // Picking a workflow closes the drawer while it is on a project.
    click(rows()[1] ?? null);
    expect(isOpen()).toBe(false);
    openDrawer();
    expect(levelTitle()).toBeUndefined();
    expect(item("workflows")).not.toBeNull();
  });

  it("drops a second tap made just after a level opened", () => {
    render();
    openDrawer();
    tap(item("workflows"), 1000);
    expect(levelTitle()).toBe("Workflows");
    tap(projectRow("p-1"), 1200);
    expect(levelTitle()).toBe("Workflows");
    tap(projectRow("p-1"), 1400);
    expect(levelTitle()).toBe("Chronicle");
    // A key press is never dropped.
    click(rows()[0] ?? null);
    expect(mocks.push).toHaveBeenCalledWith("/workflows/wf-a");
  });

  it("drops a quick second press, however late it is handled", () => {
    render();
    openDrawer();
    tap(item("workflows"), 1000);
    tap(projectRow("p-1"), 1100, 1900);
    expect(levelTitle()).toBe("Workflows");
  });

  it("measures the window from the frame that paints the level", () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((frame) => {
      frames.push(frame);
      return frames.length;
    });
    render();
    openDrawer();
    tap(item("workflows"), 1000);
    // A busy phone paints the level 300ms after it was committed.
    clock = 1300;
    for (const frame of frames.splice(0)) {
      act(() => frame(1300));
    }
    tap(projectRow("p-1"), 1500);
    expect(levelTitle()).toBe("Workflows");
    tap(projectRow("p-1"), 1700);
    expect(levelTitle()).toBe("Chronicle");
  });

  it("drops a tap just after a level's list finishes loading", () => {
    mocks.picker = pickerData({ loading: true });
    render();
    openDrawer();
    tap(item("workflows"), 1000);
    expect(projectRow("p-1")).toBeNull();
    // The rows appear under a finger that meant to tap the spinner.
    clock = 3000;
    mocks.picker = pickerData();
    render();
    tap(projectRow("p-1"), 3100);
    expect(levelTitle()).toBe("Workflows");
    tap(projectRow("p-1"), 3400);
    expect(levelTitle()).toBe("Chronicle");
  });

  it("lets through a pointer click that came without a press", () => {
    render();
    openDrawer();
    tap(item("workflows"), 1000);
    // A dropped tap, then a screen reader's click: detail 1, no pointerdown.
    tap(projectRow("p-1"), 1100);
    act(() => {
      projectRow("p-1")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 })
      );
    });
    expect(levelTitle()).toBe("Chronicle");
  });

  // Guards against the window restarting on every data change.
  it("keeps taps working after a refresh of a loaded list", () => {
    render();
    openDrawer();
    tap(item("workflows"), 1000);
    clock = 2000;
    mocks.picker = pickerData();
    render();
    tap(projectRow("p-1"), 2100);
    expect(levelTitle()).toBe("Chronicle");
  });

  it("keeps a project's rows tappable while the projects refresh", () => {
    mocks.params = { workflowId: "wf-a" };
    render();
    openDrawer();
    tap(item("workflows"), 1000);
    expect(levelTitle()).toBe("Chronicle");
    clock = 1500;
    mocks.picker = pickerData({ projectsLoading: true });
    render();
    clock = 2000;
    mocks.picker = pickerData();
    render();
    const challenger =
      rows().find((row) => row.textContent?.includes("Challenger bot")) ?? null;
    tap(challenger, 2100);
    expect(mocks.push).toHaveBeenCalledWith("/workflows/wf-b");
  });

  it("lets through a tap stamped on another clock", () => {
    render();
    openDrawer();
    tap(item("workflows"), 100_000);
    // Pressed "at 20": an event clock far behind performance.now().
    tap(projectRow("p-1"), 20, 100_100);
    expect(levelTitle()).toBe("Chronicle");
  });

  it("goes back to the list when the project is gone", () => {
    mocks.params = { workflowId: "wf-a" };
    render();
    openDrawer();
    click(item("workflows"));
    expect(levelTitle()).toBe("Chronicle");
    mocks.picker = pickerData({ projects: [] });
    render();
    expect(levelTitle()).toBe("Workflows");
  });

  it("waits for the list before deciding a project is gone", () => {
    mocks.params = { workflowId: "wf-a" };
    render();
    openDrawer();
    click(item("workflows"));
    mocks.picker = pickerData({ loading: true, projects: [] });
    render();
    expect(levelTitle()).toBe("Project");
  });

  it("sends a guest to their latest workflow, as before", () => {
    mocks.session = anonymous;
    render();
    openDrawer();
    expect(item("workflows")?.hasAttribute("aria-label")).toBe(false);
    click(item("workflows"));
    expect(mocks.push).toHaveBeenCalledWith("/workflows?latest=edited");
    expect(isOpen()).toBe(false);
  });

  it("names a member's Workflows row as opening a list", () => {
    render();
    openDrawer();
    expect(item("workflows")?.getAttribute("aria-label")).toBe(
      "Workflows, opens a list"
    );
  });

  it("gives the drawer's rows the touch size", () => {
    render();
    openDrawer();
    click(item("workflows"));
    expect(rows()[0]?.className).toContain("py-3");
    expect(projectRow("p-1")?.className).toContain("py-3");
  });
  it("returns focus to the button when nothing opens", async () => {
    render();
    openDrawer();
    click(item("hub"));
    await settleFocus();
    expect(document.activeElement).toBe(trigger());
  });

  it("returns focus on the first close after a page load", async () => {
    // useIsMobile reads false while the page hydrates, then true on a phone.
    mocks.isMobile = false;
    render();
    mocks.isMobile = true;
    render();
    openDrawer();
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
    });
    await settleFocus();
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(trigger());
  });

  it("leaves focus with the sign-in prompt", async () => {
    mocks.session = signedOut;
    render();
    openDrawer();
    click(item("analytics"));
    await settleFocus();
    expect(mocks.openAuthPrompt).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(landing);
  });

  it("leaves focus with the address book", async () => {
    render();
    openDrawer();
    click(item("address-book"));
    await settleFocus();
    expect(mocks.openOverlay).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(landing);
  });

  it("opens a picked workflow and leaves focus with it", async () => {
    render();
    openDrawer();
    click(item("workflows"));
    click(rows()[0] ?? null);
    await settleFocus();
    expect(mocks.push).toHaveBeenCalledWith("/workflows/wf-c");
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(landing);
  });

  it("returns focus to the button when the open workflow is picked", async () => {
    mocks.pathname = "/workflows/wf-a";
    mocks.params = { workflowId: "wf-a" };
    // The same page: nothing takes focus.
    mocks.push.mockImplementation(() => undefined);
    render();
    openDrawer();
    click(item("workflows"));
    click(rows()[0] ?? null);
    await settleFocus();
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(trigger());
  });
  it("leaves focus with a new workflow", async () => {
    mocks.startNewWorkflow.mockResolvedValue({ id: "wf-9", created: true });
    render();
    openDrawer();
    await act(async () => {
      newButton()?.click();
      await Promise.resolve();
    });
    await settleFocus();
    expect(mocks.push).toHaveBeenCalledWith("/workflows/wf-9");
    expect(document.activeElement).toBe(landing);
  });

  it("leaves focus with what a pick opens", async () => {
    render();
    openDrawer();
    click(item("analytics"));
    await settleFocus();
    expect(document.activeElement).toBe(landing);
  });

  it("does not focus the hidden button when the screen widens", async () => {
    render();
    openDrawer();
    mocks.isMobile = false;
    render();
    await settleFocus();
    expect(isOpen()).toBe(false);
    expect(document.activeElement).not.toBe(trigger());
  });

  it("closes when Discord or Documentation is opened", async () => {
    render();
    openDrawer();
    // The link would open a tab; the test only needs the drawer's reaction.
    // (Added after opening: Radix ignores a click already prevented.)
    const stopNavigation = (event: Event): void => event.preventDefault();
    document.addEventListener("click", stopNavigation, true);
    try {
      const docs = [
        ...document.querySelectorAll<HTMLAnchorElement>(
          "[data-testid=mobile-nav] a"
        ),
      ].find((link) => link.textContent?.includes("Documentation"));
      click(docs ?? null);
      expect(isOpen()).toBe(false);
      // The link opened a tab, nothing here: focus is back on the button.
      await settleFocus();
      expect(document.activeElement).toBe(trigger());
    } finally {
      document.removeEventListener("click", stopNavigation, true);
    }
  });

  it("goes home when creating fails", async () => {
    mocks.startNewWorkflow.mockRejectedValue(new Error("offline"));
    render();
    openDrawer();
    await act(async () => {
      newButton()?.click();
      await Promise.resolve();
    });
    expect(mocks.toastError).toHaveBeenCalledOnce();
    expect(mocks.toastError).toHaveBeenCalledWith("Failed to create workflow");
    expect(mocks.push).toHaveBeenCalledWith("/");
    // Home takes focus; it is not sent back to the drawer's button.
    await settleFocus();
    expect(document.activeElement).toBe(landing);
  });

  it("returns focus after a slow New Workflow settles while closed", async () => {
    let finish: (value: { id: string; created: boolean }) => void = () => {
      // replaced below
    };
    mocks.startNewWorkflow.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    mocks.push.mockImplementation(() => undefined);
    render();
    openDrawer();
    click(newButton());
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
    });
    // It settles with the drawer closed, as a pick would.
    await act(async () => {
      finish({ id: "wf-1", created: true });
      await Promise.resolve();
    });
    await settleFocus();
    // The next open and close is a fresh one: focus comes back.
    openDrawer();
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
    });
    await settleFocus();
    expect(document.activeElement).toBe(trigger());
  });

  it("holds the org switcher for a signed-in user", () => {
    render();
    openDrawer();
    expect(orgSwitcher()).not.toBeNull();
  });

  it("has no org switcher for a signed-out or anonymous visitor", () => {
    mocks.session = signedOut;
    render();
    openDrawer();
    expect(orgSwitcher()).toBeNull();
    act(() => root.unmount());
    root = createRoot(container);
    mocks.session = {
      data: { user: { name: "Anonymous", email: "temp-1@example.com" } },
      isPending: false,
    };
    render();
    openDrawer();
    expect(orgSwitcher()).toBeNull();
  });

  it("closes and returns focus once the organization is switched", async () => {
    render();
    openDrawer();
    click(orgSwitcher());
    expect(isOpen()).toBe(false);
    await settleFocus();
    expect(document.activeElement).toBe(trigger());
  });

  it("keeps the org switcher still while a workflow is being created", () => {
    mocks.startNewWorkflow.mockReturnValue(
      new Promise(() => {
        // never settles
      })
    );
    render();
    openDrawer();
    expect(orgSwitcher()?.disabled).toBe(false);
    click(newButton());
    expect(orgSwitcher()?.disabled).toBe(true);
  });

  it("closes when the screen widens past the phone breakpoint", () => {
    render();
    openDrawer();
    expect(isOpen()).toBe(true);
    mocks.isMobile = false;
    render();
    expect(isOpen()).toBe(false);
  });

  it("does not report a workflow it made as failed when what follows throws", async () => {
    mocks.startNewWorkflow.mockResolvedValue({ id: "wf-1", created: true });
    mocks.refetchSidebar.mockImplementationOnce(() => {
      throw new Error("sidebar");
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      render();
      openDrawer();
      await act(async () => {
        newButton()?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(mocks.toastError).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("hands its button to the header's switcher, for focus where that is hidden", () => {
    const triggerRef = { current: null as HTMLButtonElement | null };
    act(() => root.render(<MobileNav triggerRef={triggerRef} />));
    expect(triggerRef.current).not.toBeNull();
    expect(triggerRef.current).toBe(trigger());
  });
});
