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
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
  usePathname: () => mocks.pathname,
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

const signedIn = {
  data: { user: { name: "Dana", email: "dana@example.com" } },
  isPending: false,
};
const signedOut = { data: null, isPending: false };

let container: HTMLDivElement;
let root: Root;

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
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  landing.remove();
  container.remove();
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

  it("opens the latest workflow for Workflows", () => {
    render();
    openDrawer();
    click(item("workflows"));
    expect(mocks.push).toHaveBeenCalledWith("/workflows?latest=edited");
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

  it("goes to the latest workflow for Workflows from inside a workflow", () => {
    mocks.pathname = "/workflows/abc";
    render();
    openDrawer();
    click(item("workflows"));
    expect(mocks.push).toHaveBeenCalledWith("/workflows?latest=edited");
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

  it("only closes for Workflows on the workflows index", () => {
    mocks.pathname = "/workflows";
    render();
    openDrawer();
    click(item("workflows"));
    expect(mocks.push).not.toHaveBeenCalled();
    expect(isOpen()).toBe(false);
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

  it("leaves focus with the workflow Workflows opens", async () => {
    render();
    openDrawer();
    click(item("workflows"));
    await settleFocus();
    expect(mocks.push).toHaveBeenCalledWith("/workflows?latest=edited");
    expect(document.activeElement).toBe(landing);
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
