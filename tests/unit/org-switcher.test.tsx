// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Org = { id: string; name: string };

const mocks = vi.hoisted(() => ({
  organization: { id: "org-1", name: "Acme Labs" } as Org | null,
  organizations: null as Org[] | null,
  switchOrganization: vi.fn((_id: string) => Promise.resolve(true)),
  push: vi.fn(),
  toastLoading: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastDismiss: vi.fn(),
  // The org a switch took, once shown (as the auth client holds it).
  serverOrg: undefined as string | undefined,
  // A switch the server takes does not show (its refreshes fail).
  pageStale: false,
  toastInfo: vi.fn(),
  // The active org's request failed (not: no org active).
  orgError: null as Error | null,
  refetchOrg: vi.fn(),
  listFailed: false,
  orgsLoading: false,
  reloadList: vi.fn(() => Promise.resolve(true)),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
}));
vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({
    data: { user: { name: "Dana", email: "dana@example.com" } },
  }),
}));
// A switch that took, as the app's resolves: once its org is the one shown
// (as the auth client holds it), unless the page is made to fall behind.
async function switchShowing(orgId: string): Promise<boolean> {
  const switched = await mocks.switchOrganization(orgId);
  if (switched && !mocks.pageStale) {
    mocks.serverOrg = orgId;
  }
  return switched;
}

vi.mock("@/lib/hooks/use-organization", () => ({
  currentActiveOrgId: () => mocks.serverOrg ?? mocks.organization?.id,
  useOrganization: () => ({
    organization: mocks.organization,
    switchOrganization: switchShowing,
    isLoading: false,
    loadFailed: mocks.orgError !== null,
    refetch: mocks.refetchOrg,
  }),
  activeOrgLoadFailed: () => mocks.orgError !== null,
  useOrganizations: () => ({
    organizations: mocks.listFailed
      ? []
      : (mocks.organizations ??
        (mocks.organization ? [mocks.organization] : [])),
    isLoading: mocks.orgsLoading,
    hasError: mocks.listFailed,
    reload: mocks.reloadList,
  }),
}));
vi.mock("sonner", () => ({
  toast: {
    loading: mocks.toastLoading,
    success: mocks.toastSuccess,
    error: mocks.toastError,
    dismiss: mocks.toastDismiss,
    info: mocks.toastInfo,
  },
}));
vi.mock("@/components/organization/manage-orgs-modal", () => ({
  ManageOrgsModal(): null {
    return null;
  },
}));

import {
  holdOrgSwitching,
  resetOrgSwitchState,
  runOrgSwitch,
  useSwitcherOffering,
} from "@/components/organization/org-switch-runner";
import { OrgSwitcher } from "@/components/organization/org-switcher";
import { switchAwayFrom } from "@/components/organization/switch-away";

let container: HTMLDivElement;
let root: Root;

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const WIDTH_QUERY_REGEX = /\(width < ([\d.]+)rem\)/;

// A screen this many pixels wide, as media queries see it (16px to a rem).
function setWidth(width: number): void {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => {
      const bound = WIDTH_QUERY_REGEX.exec(query);
      if (!bound) {
        throw new Error(`unexpected media query: ${query}`);
      }
      const px = Number(bound[1]) * 16;
      return {
        matches: width < px,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
    })
  );
}

// jsdom lays nothing out: count elements as shown, as a browser would.
const getClientRects = HTMLElement.prototype.getClientRects;

beforeEach(() => {
  // The switch state is shared by every switcher, so a fresh page each test.
  resetOrgSwitchState();
  mocks.serverOrg = undefined;
  mocks.pageStale = false;
  HTMLElement.prototype.getClientRects = () =>
    [new DOMRect(0, 0, 1, 1)] as unknown as DOMRectList;
  setWidth(390);
  vi.clearAllMocks();
  let toasts = 0;
  mocks.toastLoading.mockImplementation(() => {
    toasts += 1;
    return `toast-${toasts}`;
  });
  // A toast updated by id keeps it; a new one gets the next.
  const shown = (_text: string, options?: { id?: string }): string => {
    if (options?.id) {
      return options.id;
    }
    toasts += 1;
    return `toast-${toasts}`;
  };
  mocks.toastSuccess.mockImplementation(shown);
  mocks.toastError.mockImplementation(shown);
  mocks.organization = { id: "org-1", name: "Acme Labs" };
  mocks.organizations = null;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  HTMLElement.prototype.getClientRects = getClientRects;
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

type Menu = { disabled: boolean; onPick: (returnFocus?: boolean) => void };

function render(menu?: Menu): HTMLButtonElement {
  act(() => root.render(<OrgSwitcher menu={menu} />));
  const switcher = container.querySelector<HTMLButtonElement>(
    menu
      ? "[data-testid=mobile-nav-org-switcher]"
      : "[data-testid=org-switcher]"
  );
  if (!switcher) {
    throw new Error("switcher not rendered");
  }
  return switcher;
}

// The list measures itself and scrolls its selection into view.
function stubListMeasuring(): void {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {
        // nothing to measure in jsdom
      }
      unobserve(): void {
        // nothing to measure in jsdom
      }
      disconnect(): void {
        // nothing to measure in jsdom
      }
    }
  );
  Element.prototype.scrollIntoView = vi.fn();
}

function openList(switcher: HTMLElement): void {
  act(() => {
    switcher.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 0 })
    );
    switcher.click();
  });
}

const TWO_ORGS = [
  { id: "org-1", name: "Acme Labs" },
  { id: "org-2", name: "Beta Corp" },
];

// Picks a row of the open list and lets the switch settle.
// Lets a tick pass, as a focus move waits for the header to catch up.
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function pick(name: string): Promise<void> {
  await act(async () => {
    option(name).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function option(name: string): HTMLElement {
  const found = [
    ...document.querySelectorAll<HTMLElement>("[role=option]"),
  ].find((row) => row.textContent?.includes(name));
  if (!found) {
    throw new Error(`${name} not listed`);
  }
  return found;
}

describe("OrgSwitcher", () => {
  it("names the org and its initials, which a phone shows instead", () => {
    const switcher = render();
    expect(switcher.getAttribute("aria-label")).toBe(
      "Acme Labs (AL), switch organization"
    );
    expect(switcher.querySelector("[data-org-initials]")?.textContent).toBe(
      "AL"
    );
    expect(switcher.querySelector("[data-org-name]")?.textContent).toBe(
      "Acme Labs"
    );
  });

  it("names a one-word org once", () => {
    mocks.organization = { id: "org-2", name: "Personal" };
    const switcher = render();
    expect(switcher.getAttribute("aria-label")).toBe(
      "Personal, switch organization"
    );
  });

  it("names what it shows up to 1023px", () => {
    setWidth(1023);
    const switcher = render();
    expect(switcher.getAttribute("aria-label")).toBe(
      "Acme Labs (AL), switch organization"
    );
  });

  it("uses the plain label from lg (1024px)", () => {
    setWidth(1024);
    const switcher = render();
    expect(switcher.getAttribute("aria-label")).toBe("Switch organization");
  });

  it("picks the first organization when none is active, quietly", async () => {
    setWidth(390);
    mocks.organization = null;
    mocks.organizations = [{ id: "org-1", name: "Acme Labs" }];
    await act(async () => {
      root.render(<OrgSwitcher />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mocks.switchOrganization).toHaveBeenCalledWith("org-1");
    // At 390px nothing else names the org, yet this switch was not asked for.
    expect(mocks.toastLoading).not.toHaveBeenCalled();
  });

  it("never opens the first org when the active one could not be loaded", async () => {
    mocks.organization = null;
    mocks.orgError = new Error("unavailable");
    mocks.organizations = [{ id: "org-1", name: "Acme Labs" }];
    try {
      await act(async () => {
        root.render(<OrgSwitcher />);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      // The user may be in another org: not knowing is not having none.
      expect(mocks.switchOrganization).not.toHaveBeenCalled();
      const retry = container.querySelector<HTMLButtonElement>(
        "[data-state=failed]"
      );
      // Named with what it shows first, for voice control.
      expect(retry?.getAttribute("aria-label")).toBe(
        "Load organization, try again"
      );
      expect(retry?.textContent).toContain("Load organization");
      await act(async () => {
        retry?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(mocks.refetchOrg).toHaveBeenCalledOnce();
      // Said as a switch is: its progress, then that it failed again.
      expect(mocks.toastLoading).toHaveBeenCalledWith(
        "Loading your organization..."
      );
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Couldn't load your organization.",
        expect.objectContaining({ duration: 12_000 })
      );
    } finally {
      mocks.orgError = null;
    }
  });

  it("loads the org again, says so, and puts focus on the switcher", async () => {
    setWidth(1280);
    mocks.organization = null;
    mocks.orgError = new Error("unavailable");
    mocks.organizations = [{ id: "org-1", name: "Acme Labs" }];
    // The reload finds the org (the auth client holds it at once).
    mocks.refetchOrg.mockImplementationOnce(() => {
      mocks.orgError = null;
      mocks.organization = { id: "org-1", name: "Acme Labs" };
      return Promise.resolve();
    });
    try {
      act(() => root.render(<OrgSwitcher />));
      (document.activeElement as HTMLElement | null)?.blur();
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>("[data-state=failed]")
          ?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        "Loaded your organization",
        expect.anything()
      );
      // The org it loaded shows: focus comes back to the switcher.
      act(() => root.render(<OrgSwitcher />));
      await settle();
      expect(document.activeElement).toBe(
        container.querySelector("[data-testid=org-switcher]")
      );
    } finally {
      mocks.orgError = null;
    }
  });

  it("offers to load the org disabled while the menu is busy", async () => {
    mocks.organization = null;
    mocks.orgError = new Error("unavailable");
    try {
      act(() =>
        root.render(<OrgSwitcher menu={{ disabled: true, onPick: vi.fn() }} />)
      );
      expect(
        container.querySelector<HTMLButtonElement>("[data-state=failed]")
          ?.disabled
      ).toBe(true);
    } finally {
      mocks.orgError = null;
    }
  });

  it("says when it offers to try again, for a header that hides it", async () => {
    let offering = false;
    function Reader(): null {
      offering = useSwitcherOffering();
      return null;
    }
    mocks.switchOrganization.mockResolvedValueOnce(false);
    mocks.organization = null;
    mocks.organizations = [{ id: "org-1", name: "Acme Labs" }];
    await act(async () => {
      root.render(
        <>
          <OrgSwitcher />
          <Reader />
        </>
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(offering).toBe(true);
    mocks.organization = { id: "org-1", name: "Acme Labs" };
    act(() =>
      root.render(
        <>
          <OrgSwitcher />
          <Reader />
        </>
      )
    );
    expect(offering).toBe(false);
  });

  it("offers to load, not to create one, when the list failed", async () => {
    mocks.organization = null;
    mocks.listFailed = true;
    try {
      act(() => root.render(<OrgSwitcher />));
      const state = container.querySelector("[data-state]");
      expect(state?.getAttribute("data-state")).toBe("failed");
      expect(state?.getAttribute("aria-label")).toBe(
        "Load organization, try again"
      );
    } finally {
      mocks.listFailed = false;
    }
  });

  it("tries that once, and offers it again when it fails", async () => {
    mocks.switchOrganization.mockResolvedValueOnce(false);
    mocks.organization = null;
    mocks.organizations = [{ id: "org-1", name: "Acme Labs" }];
    await act(async () => {
      root.render(<OrgSwitcher />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      root.render(<OrgSwitcher />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mocks.switchOrganization).toHaveBeenCalledOnce();
    expect(mocks.toastError).toHaveBeenCalledWith(
      "Couldn't open Acme Labs.",
      expect.objectContaining({ duration: 12_000 })
    );
    // Not a dead end: the switcher offers to open it.
    const retry = container.querySelector<HTMLButtonElement>(
      "[data-state=failed]"
    );
    expect(retry?.disabled).toBe(false);
    expect(retry?.textContent).toContain("Open Acme Labs");
    // The same name at every width, saying it failed.
    expect(retry?.getAttribute("aria-label")).toBe("Try again: open Acme Labs");
    await act(async () => {
      retry?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mocks.switchOrganization).toHaveBeenCalledTimes(2);
  });

  it("does not try again when remounted after a failure", async () => {
    mocks.switchOrganization.mockResolvedValueOnce(false);
    mocks.organization = null;
    mocks.organizations = [{ id: "org-1", name: "Acme Labs" }];
    await act(async () => {
      root.render(<OrgSwitcher />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // A new page: a fresh switcher, the failure still offered.
    act(() => root.unmount());
    root = createRoot(container);
    await act(async () => {
      root.render(<OrgSwitcher />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mocks.switchOrganization).toHaveBeenCalledOnce();
    expect(container.querySelector("[data-state=failed]")).not.toBeNull();
  });

  it("opens one itself once a switch someone else ran with no org active has failed", async () => {
    // A link's plain switch with no org active, holding the switchers.
    mocks.organization = null;
    mocks.organizations = [{ id: "org-1", name: "Acme Labs" }];
    let done: () => void = () => undefined;
    const held = holdOrgSwitching(
      () =>
        new Promise<void>((resolve) => {
          done = resolve;
        })
    );
    await act(async () => {
      root.render(<OrgSwitcher />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mocks.switchOrganization).not.toHaveBeenCalled();
    // It failed, offering nothing: the switcher is not left on Loading.
    await act(async () => {
      done();
      await held;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mocks.switchOrganization).toHaveBeenCalledWith("org-1");
  });

  it("opens one again when the active org goes a second time", async () => {
    mocks.switchOrganization.mockResolvedValue(true);
    mocks.organization = null;
    mocks.organizations = [{ id: "org-1", name: "Acme Labs" }];
    await act(async () => {
      root.render(<OrgSwitcher />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    mocks.organization = { id: "org-1", name: "Acme Labs" };
    act(() => root.render(<OrgSwitcher />));
    // Removed by an admin, say: nothing holds the switchers.
    mocks.organization = null;
    await act(async () => {
      root.render(<OrgSwitcher />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // The list may still hold the org that went: it is loaded afresh first.
    expect(mocks.reloadList).toHaveBeenCalledOnce();
    expect(mocks.switchOrganization).toHaveBeenCalledOnce();
    // It arrives, without the org that went.
    mocks.organizations = [{ id: "org-2", name: "Beta Corp" }];
    await act(async () => {
      root.render(<OrgSwitcher />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mocks.switchOrganization).toHaveBeenCalledTimes(2);
    expect(mocks.switchOrganization).toHaveBeenLastCalledWith("org-2");
  });

  it("offers to open the org in both switchers after a failed first switch", async () => {
    mocks.switchOrganization.mockResolvedValueOnce(false);
    mocks.organization = null;
    mocks.organizations = [{ id: "org-1", name: "Acme Labs" }];
    await act(async () => {
      root.render(
        <>
          <OrgSwitcher />
          <OrgSwitcher menu={{ disabled: false, onPick: vi.fn() }} />
        </>
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // The menu's too: below 375px it is the only one shown.
    expect(container.querySelectorAll("[data-state=failed]")).toHaveLength(2);
  });

  it("shows no failure while a first switch that worked loads its org", async () => {
    mocks.organization = null;
    mocks.organizations = [{ id: "org-1", name: "Acme Labs" }];
    await act(async () => {
      root.render(<OrgSwitcher />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.querySelector("[data-state=failed]")).toBeNull();
    expect(container.querySelector("[data-state=loading]")).not.toBeNull();
  });

  it("keeps focus on Open X, and announces its switch", async () => {
    mocks.switchOrganization.mockResolvedValueOnce(false);
    mocks.organization = null;
    mocks.organizations = [{ id: "org-1", name: "Acme Labs" }];
    await act(async () => {
      root.render(<OrgSwitcher />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    let answer: (switched: boolean) => void = () => undefined;
    mocks.switchOrganization.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      })
    );
    const retry = container.querySelector<HTMLButtonElement>(
      "[data-state=failed]"
    );
    try {
      act(() => {
        retry?.focus();
        retry?.click();
      });
      const switching = container.querySelector<HTMLButtonElement>(
        "[data-state=switching]"
      );
      expect(switching?.getAttribute("aria-busy")).toBe("true");
      expect(switching?.disabled).toBe(false);
      expect(document.activeElement).toBe(switching);
      expect(mocks.toastLoading).toHaveBeenCalledWith("Opening Acme Labs...");
    } finally {
      await act(async () => {
        answer(true);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  });

  it("does not open the first org while another switch runs", async () => {
    let release: () => void = () => undefined;
    const held = holdOrgSwitching(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    mocks.organization = null;
    mocks.organizations = [{ id: "org-1", name: "Acme Labs" }];
    await act(async () => {
      root.render(<OrgSwitcher />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mocks.switchOrganization).not.toHaveBeenCalled();
    await act(async () => {
      release();
      await held;
    });
  });

  it("leaves choosing the org to a leave or delete that holds the switchers", async () => {
    // Mounted with an org, which leaving it then clears.
    render();
    mocks.organization = null;
    mocks.organizations = [
      { id: "org-1", name: "Acme Labs" },
      { id: "org-2", name: "Beta Corp" },
    ];
    await act(async () => {
      await switchAwayFrom({
        removed: { id: "org-1", name: "Acme Labs" },
        wasActive: true,
        organizations: mocks.organizations ?? [],
        done: "Left",
        switchOrganization: async () => {
          // The org goes from the page while the leave still switches.
          root.render(<OrgSwitcher />);
          await new Promise((resolve) => setTimeout(resolve, 0));
          return false;
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // The switcher never opened one itself (least of all the one left), and
    // offers to open the next, not the one left.
    expect(mocks.switchOrganization).not.toHaveBeenCalled();
    expect(
      container.querySelector("[data-state=failed]")?.getAttribute("title")
    ).toBe("Try again: open Beta Corp");
  });

  it("forgets a failure once an org becomes active", async () => {
    mocks.switchOrganization.mockResolvedValueOnce(false);
    mocks.organization = null;
    mocks.organizations = [{ id: "org-1", name: "Acme Labs" }];
    await act(async () => {
      root.render(<OrgSwitcher />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.querySelector("[data-state=failed]")).not.toBeNull();
    // Opened some other way (a settings page, the manage dialog).
    mocks.organization = { id: "org-1", name: "Acme Labs" };
    act(() => root.render(<OrgSwitcher />));
    mocks.organization = null;
    // With none active again, it opens one itself, which settles a tick on.
    await act(async () => {
      root.render(<OrgSwitcher />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.querySelector("[data-state=failed]")).toBeNull();
  });

  it("closes the menu before opening the org from it", async () => {
    mocks.switchOrganization
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    mocks.organization = null;
    mocks.organizations = [{ id: "org-1", name: "Acme Labs" }];
    await act(async () => {
      root.render(<OrgSwitcher />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const onPick = vi.fn();
    act(() => root.render(<OrgSwitcher menu={{ disabled: false, onPick }} />));
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>("[data-state=failed]")
        ?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(onPick).toHaveBeenCalledWith(true);
    expect(mocks.switchOrganization).toHaveBeenCalledTimes(2);
  });

  it("puts focus on the switcher once Open X has opened the org, and says so at lg", async () => {
    setWidth(1280);
    mocks.switchOrganization
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    mocks.organization = null;
    mocks.organizations = [{ id: "org-1", name: "Acme Labs" }];
    await act(async () => {
      root.render(<OrgSwitcher />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>("[data-state=failed]")
        ?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    mocks.organization = { id: "org-1", name: "Acme Labs" };
    // Asked for, so said even where the name shows.
    expect(mocks.toastLoading).toHaveBeenCalledWith("Opening Acme Labs...");
    // Focus moves once the header has caught up, a tick on.
    act(() => root.render(<OrgSwitcher />));
    await settle();
    expect(document.activeElement).toBe(
      container.querySelector("[data-testid=org-switcher]")
    );
  });

  describe("in the header", () => {
    it("gives focus back to the header switcher after a pick", async () => {
      setWidth(1280);
      let answer: (switched: boolean) => void = () => undefined;
      mocks.switchOrganization.mockReturnValueOnce(
        new Promise((resolve) => {
          answer = resolve;
        })
      );
      mocks.organizations = TWO_ORGS;
      stubListMeasuring();
      const switcher = render();
      try {
        openList(switcher);
        await pick("Beta Corp");
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
        expect(document.activeElement).toBe(switcher);
      } finally {
        await act(async () => {
          answer(true);
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      }
    });

    it("announces a switch below lg, where initials can stand in", async () => {
      for (const width of [390, 1023]) {
        vi.clearAllMocks();
        mocks.serverOrg = undefined;
        setWidth(width);
        mocks.organizations = TWO_ORGS;
        stubListMeasuring();
        openList(render());
        await pick("Beta Corp");
        expect(mocks.switchOrganization).toHaveBeenCalledWith("org-2");
        expect(mocks.toastSuccess).toHaveBeenCalledWith(
          "Switched to Beta Corp",
          { id: expect.stringMatching(/^toast-/) }
        );
      }
    });

    it("only closes for the org already in use, at any width", async () => {
      for (const width of [1023, 1024]) {
        vi.clearAllMocks();
        mocks.serverOrg = undefined;
        setWidth(width);
        mocks.organizations = TWO_ORGS;
        stubListMeasuring();
        openList(render());
        await pick("Acme Labs");
        expect(document.querySelector("[role=option]")).toBeNull();
        expect(mocks.switchOrganization).not.toHaveBeenCalled();
        expect(mocks.toastLoading).not.toHaveBeenCalled();
        expect(mocks.toastSuccess).not.toHaveBeenCalled();
      }
    });

    it("from lg, says only when a switch fails", async () => {
      setWidth(1024);
      mocks.switchOrganization.mockResolvedValueOnce(false);
      mocks.organizations = TWO_ORGS;
      stubListMeasuring();
      openList(render());
      await pick("Beta Corp");
      expect(mocks.toastLoading).not.toHaveBeenCalled();
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Couldn't switch to Beta Corp.",
        expect.objectContaining({ duration: 12_000 })
      );
    });

    it("from lg, switches without a toast", async () => {
      setWidth(1024);
      mocks.organizations = TWO_ORGS;
      stubListMeasuring();
      openList(render());
      await pick("Beta Corp");
      expect(mocks.switchOrganization).toHaveBeenCalledWith("org-2");
      expect(mocks.toastLoading).not.toHaveBeenCalled();
      expect(mocks.toastSuccess).not.toHaveBeenCalled();
      expect(mocks.toastError).not.toHaveBeenCalled();
      // Never without an id, which would clear every toast.
      expect(mocks.toastDismiss).not.toHaveBeenCalledWith(undefined);
    });
  });

  describe("in the phone menu", () => {
    it("renders as the menu's own switcher, with the org's name", () => {
      const switcher = render({ disabled: false, onPick: vi.fn() });
      expect(container.querySelector("[data-testid=org-switcher]")).toBeNull();
      expect(switcher.querySelector("[data-org-name]")?.textContent).toBe(
        "Acme Labs"
      );
    });

    it("switches, then closes the menu with focus going back to it", async () => {
      mocks.organizations = TWO_ORGS;
      stubListMeasuring();
      const onPick = vi.fn();
      openList(render({ disabled: false, onPick }));
      await pick("Beta Corp");
      expect(mocks.switchOrganization).toHaveBeenCalledWith("org-2");
      expect(onPick).toHaveBeenCalledWith(true);
      // Nothing on a small phone's screen names the org, so a toast does,
      // from the moment of the tap.
      expect(mocks.toastLoading).toHaveBeenCalledWith(
        "Switching to Beta Corp..."
      );
      expect(mocks.toastSuccess).toHaveBeenCalledWith("Switched to Beta Corp", {
        id: "toast-1",
      });
      expect(mocks.toastError).not.toHaveBeenCalled();
    });

    it("says so when the switch fails", async () => {
      mocks.switchOrganization.mockResolvedValueOnce(false);
      mocks.organizations = TWO_ORGS;
      stubListMeasuring();
      openList(render({ disabled: false, onPick: vi.fn() }));
      await pick("Beta Corp");
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Couldn't switch to Beta Corp.",
        // Longer than a success, as it asks for something to be done.
        expect.objectContaining({ id: "toast-1", duration: 12_000 })
      );
      expect(mocks.toastSuccess).not.toHaveBeenCalled();
    });

    it("tries the same switch again from the failure toast", async () => {
      mocks.switchOrganization.mockResolvedValueOnce(false);
      mocks.organizations = TWO_ORGS;
      stubListMeasuring();
      openList(render({ disabled: false, onPick: vi.fn() }));
      await pick("Beta Corp");
      const options = mocks.toastError.mock.calls[0]?.[1] as {
        action: { label: string; onClick: () => void };
      };
      expect(options.action.label).toBe("Try again");
      await act(async () => {
        options.action.onClick();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(mocks.switchOrganization).toHaveBeenCalledTimes(2);
      expect(mocks.switchOrganization).toHaveBeenLastCalledWith("org-2");
      // A fresh toast for the new try.
      expect(mocks.toastSuccess).toHaveBeenCalledWith("Switched to Beta Corp", {
        id: "toast-2",
      });
    });

    it("runs one switch at a time: the switcher waits, busy, and keeps focus", async () => {
      let answer: (switched: boolean) => void = () => undefined;
      mocks.switchOrganization.mockReturnValueOnce(
        new Promise((resolve) => {
          answer = resolve;
        })
      );
      mocks.organizations = TWO_ORGS;
      stubListMeasuring();
      const switcher = render({ disabled: false, onPick: vi.fn() });
      try {
        openList(switcher);
        await pick("Beta Corp");
        expect(switcher.getAttribute("aria-busy")).toBe("true");
        expect(switcher.getAttribute("aria-disabled")).toBe("true");
        // Not disabled, so it can hold focus; its list stays shut.
        expect(switcher.disabled).toBe(false);
        openList(switcher);
        expect(document.querySelector("[role=option]")).toBeNull();
      } finally {
        await act(async () => {
          answer(true);
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      }
      expect(switcher.hasAttribute("aria-busy")).toBe(false);
      expect(switcher.hasAttribute("aria-disabled")).toBe(false);
    });

    it("clears the last switch's toast when the next starts", async () => {
      mocks.switchOrganization
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);
      mocks.organizations = [...TWO_ORGS, { id: "org-3", name: "Gamma Inc" }];
      stubListMeasuring();
      const switcher = render({ disabled: false, onPick: vi.fn() });
      openList(switcher);
      await pick("Beta Corp");
      mocks.toastDismiss.mockClear();
      openList(switcher);
      await pick("Gamma Inc");
      // Exactly the failure's toast; never without an id, which would clear
      // every toast.
      expect(mocks.toastDismiss.mock.calls).toEqual([["toast-1"]]);
    });

    it("ignores a Try again while another switch runs", async () => {
      let answer: (switched: boolean) => void = () => undefined;
      mocks.switchOrganization.mockResolvedValueOnce(false).mockReturnValueOnce(
        new Promise((resolve) => {
          answer = resolve;
        })
      );
      mocks.organizations = [...TWO_ORGS, { id: "org-3", name: "Gamma Inc" }];
      stubListMeasuring();
      const switcher = render({ disabled: false, onPick: vi.fn() });
      openList(switcher);
      await pick("Beta Corp");
      const stale = mocks.toastError.mock.calls[0]?.[1] as {
        action: { onClick: () => void };
      };
      openList(switcher);
      await pick("Gamma Inc");
      try {
        act(() => stale.action.onClick());
        expect(mocks.switchOrganization).toHaveBeenCalledTimes(2);
      } finally {
        await act(async () => {
          answer(true);
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      }
    });

    it("does not try again for an org that has since become active", async () => {
      mocks.switchOrganization.mockResolvedValueOnce(false);
      mocks.organizations = TWO_ORGS;
      stubListMeasuring();
      openList(render({ disabled: false, onPick: vi.fn() }));
      await pick("Beta Corp");
      const options = mocks.toastError.mock.calls[0]?.[1] as {
        action: { onClick: () => void };
      };
      // The server took it after all (its answer was lost).
      mocks.organization = { id: "org-2", name: "Beta Corp" };
      render({ disabled: false, onPick: vi.fn() });
      act(() => options.action.onClick());
      expect(mocks.switchOrganization).toHaveBeenCalledOnce();
    });

    it("tries again after the menu has closed", async () => {
      mocks.switchOrganization.mockResolvedValueOnce(false);
      mocks.organizations = TWO_ORGS;
      stubListMeasuring();
      openList(render({ disabled: false, onPick: vi.fn() }));
      await pick("Beta Corp");
      const options = mocks.toastError.mock.calls[0]?.[1] as {
        action: { onClick: () => void };
      };
      // The drawer, and its switcher, are gone by the time it is tapped.
      act(() => root.unmount());
      root = createRoot(container);
      await act(async () => {
        options.action.onClick();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(mocks.switchOrganization).toHaveBeenCalledTimes(2);
      expect(mocks.toastSuccess).toHaveBeenCalledWith("Switched to Beta Corp", {
        id: "toast-2",
      });
    });

    it("says so when the switch throws", async () => {
      mocks.switchOrganization.mockRejectedValueOnce(new Error("offline"));
      mocks.organizations = TWO_ORGS;
      stubListMeasuring();
      openList(render({ disabled: false, onPick: vi.fn() }));
      await pick("Beta Corp");
      expect(mocks.toastError).toHaveBeenCalledOnce();
      expect(mocks.toastSuccess).not.toHaveBeenCalled();
    });

    it("only closes for the org already in use", async () => {
      mocks.organizations = TWO_ORGS;
      stubListMeasuring();
      const onPick = vi.fn();
      openList(render({ disabled: false, onPick }));
      await pick("Acme Labs");
      expect(onPick).toHaveBeenCalledWith(true);
      expect(document.querySelector("[role=option]")).toBeNull();
      expect(mocks.switchOrganization).not.toHaveBeenCalled();
      expect(mocks.toastLoading).not.toHaveBeenCalled();
    });

    it("opens the org's settings from its gear, without switching", async () => {
      stubListMeasuring();
      const onPick = vi.fn();
      openList(render({ disabled: false, onPick }));
      const gear = document.querySelector<HTMLButtonElement>(
        '[aria-label="Settings for Acme Labs"]'
      );
      await act(async () => {
        gear?.click();
        await Promise.resolve();
      });
      expect(onPick).toHaveBeenCalledWith();
      expect(mocks.push).toHaveBeenCalledWith("/settings/org-1/organization");
      expect(mocks.switchOrganization).not.toHaveBeenCalled();
      expect(mocks.toastLoading).not.toHaveBeenCalled();
    });

    it("is disabled while the menu is busy", () => {
      const switcher = render({ disabled: true, onPick: vi.fn() });
      expect(switcher.disabled).toBe(true);
    });

    it("leaves picking a first organization to the header's switcher", async () => {
      mocks.organization = null;
      mocks.organizations = [{ id: "org-1", name: "Acme Labs" }];
      // A switch starts a tick after it is asked for.
      await act(async () => {
        root.render(
          <OrgSwitcher menu={{ disabled: false, onPick: vi.fn() }} />
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(mocks.switchOrganization).not.toHaveBeenCalled();
    });

    it("offers a failed org disabled while the menu is busy", async () => {
      mocks.switchOrganization.mockResolvedValueOnce(false);
      mocks.organization = null;
      mocks.organizations = [{ id: "org-1", name: "Acme Labs" }];
      await act(async () => {
        root.render(<OrgSwitcher />);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      act(() =>
        root.render(<OrgSwitcher menu={{ disabled: true, onPick: vi.fn() }} />)
      );
      expect(
        container.querySelector<HTMLButtonElement>("[data-state=failed]")
          ?.disabled
      ).toBe(true);
    });
  });

  describe("a switch someone else ran that failed with no org active", () => {
    it("offers its org, keeps its failure, and opens no other", async () => {
      // A digest link's plain switch to Beta, with no org active.
      mocks.organization = null;
      mocks.organizations = TWO_ORGS;
      let answer: (switched: boolean) => void = () => undefined;
      mocks.switchOrganization.mockReturnValueOnce(
        new Promise((resolve) => {
          answer = resolve;
        })
      );
      mocks.toastError.mockReturnValueOnce("toast-failed");
      const onSwitched = vi.fn();
      // The link's switch holds the switchers as the page comes up.
      const switching = runOrgSwitch({
        orgId: "org-2",
        name: "Beta Corp",
        start: () => mocks.switchOrganization("org-2"),
        announce: true,
        onSwitched,
      });
      act(() => root.render(<OrgSwitcher />));
      // It fails.
      await act(async () => {
        answer(false);
        await switching;
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await settle();
      // Not Acme opened over it, its failure toast cleared.
      expect(mocks.switchOrganization).not.toHaveBeenCalledWith("org-1");
      expect(mocks.toastDismiss).not.toHaveBeenCalledWith("toast-failed");
      const offer = container.querySelector<HTMLButtonElement>(
        "[data-state=failed]"
      );
      expect(offer?.getAttribute("aria-label")).toBe(
        "Try again: open Beta Corp"
      );
      // Opening it from the switcher still does what the link was for.
      mocks.switchOrganization.mockResolvedValueOnce(true);
      await act(async () => {
        offer?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      // Beta again (the failed try, then this one).
      expect(
        mocks.switchOrganization.mock.calls.filter(([id]) => id === "org-2")
      ).toHaveLength(2);
      expect(onSwitched).toHaveBeenCalledOnce();
    });
  });

  describe("a switch the page could not show", () => {
    it("says the page is behind, not that it switched, and lets the org shown be picked", async () => {
      setWidth(390);
      mocks.organizations = TWO_ORGS;
      // The server takes the switch; the page's refreshes all fail.
      mocks.pageStale = true;
      mocks.switchOrganization.mockResolvedValueOnce(true);
      stubListMeasuring();
      const switcher = render();
      openList(switcher);
      await pick("Beta Corp");
      expect(mocks.toastSuccess).not.toHaveBeenCalled();
      // In place of "Switching to Beta Corp...", not beside it.
      const loading = mocks.toastLoading.mock.results[0]?.value;
      expect(loading).toBeDefined();
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Switched organization, but couldn't update the page.",
        expect.objectContaining({
          id: loading,
          duration: 12_000,
          action: expect.objectContaining({ label: "Reload" }),
        })
      );
      const behindToast = mocks.toastError.mock.results.at(-1)?.value;
      // The header still names Acme, which the server is no longer in:
      // picking it runs a switch (and clears the toast) rather than nothing.
      mocks.pageStale = false;
      mocks.switchOrganization.mockResolvedValueOnce(true);
      openList(render());
      await pick("Acme Labs");
      expect(mocks.switchOrganization).toHaveBeenLastCalledWith("org-1");
      expect(mocks.toastDismiss).toHaveBeenCalledWith(behindToast);
      // Acme shows and is in use again: picking it once more only closes
      // the list.
      openList(render());
      await pick("Acme Labs");
      expect(mocks.switchOrganization).toHaveBeenCalledTimes(2);
    });

    it("takes the org in use as active again once the page moves on to another", async () => {
      setWidth(390);
      const gamma = { id: "org-3", name: "Gamma Inc" };
      mocks.organizations = [...TWO_ORGS, gamma];
      // A switch to Beta the page could not show: it still shows Acme.
      mocks.pageStale = true;
      mocks.switchOrganization.mockResolvedValueOnce(true);
      stubListMeasuring();
      openList(render());
      await pick("Beta Corp");
      // Then it shows Gamma (Acme left, and Gamma opened).
      mocks.pageStale = false;
      mocks.organization = gamma;
      mocks.serverOrg = "org-3";
      openList(render());
      // Gamma is in use: picking it only closes the list.
      await pick("Gamma Inc");
      expect(mocks.switchOrganization).not.toHaveBeenCalledWith("org-3");
    });
  });

  describe("a switch the page could not show, with no org shown", () => {
    it("opens no other org over it", async () => {
      // A digest link's switch to Beta with no org active: the server takes
      // it; the page still shows none.
      mocks.organization = null;
      mocks.organizations = TWO_ORGS;
      mocks.pageStale = true;
      let answer: (switched: boolean) => void = () => undefined;
      mocks.switchOrganization.mockReturnValueOnce(
        new Promise((resolve) => {
          answer = resolve;
        })
      );
      mocks.toastError.mockReturnValueOnce("toast-behind");
      const switching = runOrgSwitch({
        orgId: "org-2",
        name: "Beta Corp",
        start: () => switchShowing("org-2"),
        announce: true,
      });
      act(() => root.render(<OrgSwitcher />));
      await act(async () => {
        answer(true);
        await switching;
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await settle();
      // Not Acme opened over it (taking the server from Beta), its toast
      // left up.
      expect(mocks.switchOrganization).not.toHaveBeenCalledWith("org-1");
      expect(mocks.toastDismiss).not.toHaveBeenCalledWith("toast-behind");
    });
  });

  describe("a link's switch the page could not show", () => {
    it("does what the link was for only once the page shows its org", async () => {
      mocks.organizations = TWO_ORGS;
      mocks.pageStale = true;
      mocks.switchOrganization.mockResolvedValueOnce(true);
      act(() => root.render(<OrgSwitcher />));
      const onSwitched = vi.fn();
      // A digest link's switch to Beta: made, but the page still shows Acme.
      await act(async () => {
        await runOrgSwitch({
          orgId: "org-2",
          name: "Beta Corp",
          start: () => switchShowing("org-2"),
          announce: true,
          onSwitched,
        });
      });
      // Not its settings opened on Acme's page.
      expect(onSwitched).not.toHaveBeenCalled();
      // The page catches up: now it opens them, once.
      mocks.organization = { id: "org-2", name: "Beta Corp" };
      act(() => root.render(<OrgSwitcher />));
      expect(onSwitched).toHaveBeenCalledOnce();
      act(() => root.render(<OrgSwitcher />));
      expect(onSwitched).toHaveBeenCalledOnce();
    });

    it("drops what the link was for once another switch starts", async () => {
      mocks.organizations = TWO_ORGS;
      mocks.pageStale = true;
      mocks.switchOrganization.mockResolvedValue(true);
      act(() => root.render(<OrgSwitcher />));
      const onSwitched = vi.fn();
      await act(async () => {
        await runOrgSwitch({
          orgId: "org-2",
          name: "Beta Corp",
          start: () => switchShowing("org-2"),
          announce: true,
          onSwitched,
        });
      });
      // The user picks Acme, the org the page shows, which fails; then Beta
      // shows: the link's settings are not opened on their own.
      await act(async () => {
        await runOrgSwitch({
          orgId: "org-1",
          name: "Acme Labs",
          start: () => Promise.resolve(false),
          announce: false,
        });
      });
      mocks.organization = { id: "org-2", name: "Beta Corp" };
      act(() => root.render(<OrgSwitcher />));
      expect(onSwitched).not.toHaveBeenCalled();
    });
  });

  describe("a link's switch the page could not show, then another org", () => {
    it("does not do what the link was for on another org's page", async () => {
      const gamma = { id: "org-3", name: "Gamma Inc" };
      mocks.organizations = [...TWO_ORGS, gamma];
      mocks.pageStale = true;
      mocks.switchOrganization.mockResolvedValueOnce(true);
      act(() => root.render(<OrgSwitcher />));
      const onSwitched = vi.fn();
      await act(async () => {
        await runOrgSwitch({
          orgId: "org-2",
          name: "Beta Corp",
          start: () => switchShowing("org-2"),
          announce: true,
          onSwitched,
        });
      });
      // The page moves on to Gamma (a switch in another tab), not Beta.
      mocks.organization = gamma;
      act(() => root.render(<OrgSwitcher />));
      expect(onSwitched).not.toHaveBeenCalled();
    });
  });

  describe("a switch with no switcher mounted", () => {
    it("knows the org already active from the auth client", async () => {
      mocks.organization = { id: "org-2", name: "Beta Corp" };
      // Nothing mounted (a bare layout): still not run for the active org.
      expect(
        await runOrgSwitch({
          orgId: "org-2",
          name: "Beta Corp",
          start: () => Promise.resolve(true),
          announce: false,
        })
      ).toBeNull();
      expect(
        await runOrgSwitch({
          orgId: "org-3",
          name: "Gamma",
          start: () => Promise.resolve(true),
          announce: false,
        })
      ).toBe(true);
    });
  });

  describe("the switch lock", () => {
    it("stays held until every holder is done", async () => {
      let answer: (switched: boolean) => void = () => undefined;
      const switching = runOrgSwitch({
        orgId: "org-2",
        name: "Beta Corp",
        start: () =>
          new Promise((resolve) => {
            answer = resolve;
          }),
        announce: false,
      });
      let releaseHold: () => void = () => undefined;
      const held = holdOrgSwitching(
        () =>
          new Promise<void>((resolve) => {
            releaseHold = resolve;
          })
      );
      // The start runs a tick later, so a start that throws lets go too.
      await new Promise((resolve) => setTimeout(resolve, 0));
      answer(true);
      await switching;
      // The hold is still on: no other switch runs.
      expect(
        await runOrgSwitch({
          orgId: "org-3",
          name: "Gamma",
          start: () => Promise.resolve(true),
          announce: false,
        })
      ).toBeNull();
      releaseHold();
      await held;
    });

    // As in the app: the new org shows before the switch is done (on a
    // workflow page it then finds the workflow to open).
    async function tryAgainShowingFirst(
      setUp: () => void = () => undefined
    ): Promise<void> {
      let answer: (switched: boolean) => void = () => undefined;
      mocks.switchOrganization.mockResolvedValueOnce(false).mockReturnValueOnce(
        new Promise((resolve) => {
          answer = resolve;
        })
      );
      mocks.organizations = TWO_ORGS;
      stubListMeasuring();
      const switcher = render();
      openList(switcher);
      await pick("Beta Corp");
      const options = mocks.toastError.mock.calls[0]?.[1] as {
        action: { onClick: () => void };
      };
      // The toast held focus, and goes.
      (document.activeElement as HTMLElement | null)?.blur();
      act(() => options.action.onClick());
      setUp();
      mocks.organization = { id: "org-2", name: "Beta Corp" };
      render();
      await act(async () => {
        answer(true);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }

    it("puts focus back on the switcher after a Try again that works", async () => {
      setWidth(1280);
      await tryAgainShowingFirst();
      expect(document.activeElement).toBe(
        container.querySelector("[data-testid=org-switcher]")
      );
      // Taken: a later change of org back to it does not move focus, even
      // with focus nowhere.
      (document.activeElement as HTMLElement | null)?.blur();
      mocks.organization = { id: "org-1", name: "Acme Labs" };
      render();
      mocks.organization = { id: "org-2", name: "Beta Corp" };
      render();
      await settle();
      expect(document.activeElement).toBe(document.body);
    });

    it("leaves focus alone for a switch nobody asked focus for", async () => {
      setWidth(1280);
      render();
      (document.activeElement as HTMLElement | null)?.blur();
      // A switch made elsewhere (a settings link, say).
      await act(async () => {
        await runOrgSwitch({
          orgId: "org-2",
          name: "Beta Corp",
          start: () => Promise.resolve(true),
          announce: false,
        });
      });
      mocks.organization = { id: "org-2", name: "Beta Corp" };
      render();
      await settle();
      expect(document.activeElement).toBe(document.body);
    });

    it("announces a Try again of a switch at every width", async () => {
      setWidth(1280);
      mocks.switchOrganization
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);
      mocks.organizations = TWO_ORGS;
      stubListMeasuring();
      const switcher = render();
      openList(switcher);
      await pick("Beta Corp");
      // From lg the name shows: the pick itself was quiet.
      expect(mocks.toastLoading).not.toHaveBeenCalled();
      const options = mocks.toastError.mock.calls[0]?.[1] as {
        action: { onClick: () => void };
      };
      await act(async () => {
        options.action.onClick();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(mocks.toastLoading).toHaveBeenCalledWith(
        "Switching to Beta Corp..."
      );
    });

    it("leaves focus where the user moved it while a Try again ran", async () => {
      setWidth(1280);
      const elsewhere = document.createElement("input");
      document.body.appendChild(elsewhere);
      await tryAgainShowingFirst(() => elsewhere.focus());
      expect(document.activeElement).toBe(elsewhere);
      elsewhere.remove();
    });

    it("hands focus to the menu button where the header switcher is hidden", async () => {
      setWidth(1280);
      mocks.switchOrganization
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);
      mocks.organizations = TWO_ORGS;
      stubListMeasuring();
      const menuButton = document.createElement("button");
      document.body.appendChild(menuButton);
      const fallback = { current: menuButton };
      act(() => root.render(<OrgSwitcher focusFallback={fallback} />));
      const switcher = container.querySelector<HTMLButtonElement>(
        "[data-testid=org-switcher]"
      );
      if (!switcher) {
        throw new Error("switcher not rendered");
      }
      openList(switcher);
      await pick("Beta Corp");
      const options = mocks.toastError.mock.calls[0]?.[1] as {
        action: { onClick: () => void };
      };
      (document.activeElement as HTMLElement | null)?.blur();
      await act(async () => {
        options.action.onClick();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      // Below xs the header switcher is hidden; the menu button shows.
      HTMLElement.prototype.getClientRects = function (
        this: HTMLElement
      ): DOMRectList {
        return (this === menuButton
          ? [new DOMRect(0, 0, 1, 1)]
          : []) as unknown as DOMRectList;
      };
      mocks.organization = { id: "org-2", name: "Beta Corp" };
      act(() => root.render(<OrgSwitcher focusFallback={fallback} />));
      await settle();
      expect(document.activeElement).toBe(menuButton);
      menuButton.remove();
    });

    it("leaves focus be where neither the switcher nor the menu button shows", async () => {
      // A 768-1023px window with a mouse: the switcher there only while it
      // offers to open an org, no menu button.
      setWidth(900);
      mocks.switchOrganization
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);
      mocks.organizations = TWO_ORGS;
      stubListMeasuring();
      const menuButton = document.createElement("button");
      document.body.appendChild(menuButton);
      const fallback = { current: menuButton };
      act(() => root.render(<OrgSwitcher focusFallback={fallback} />));
      const switcher = container.querySelector<HTMLButtonElement>(
        "[data-testid=org-switcher]"
      );
      if (!switcher) {
        throw new Error("switcher not rendered");
      }
      openList(switcher);
      await pick("Beta Corp");
      const options = mocks.toastError.mock.calls[0]?.[1] as {
        action: { onClick: () => void };
      };
      (document.activeElement as HTMLElement | null)?.blur();
      await act(async () => {
        options.action.onClick();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      HTMLElement.prototype.getClientRects = () => [] as unknown as DOMRectList;
      mocks.organization = { id: "org-2", name: "Beta Corp" };
      act(() => root.render(<OrgSwitcher focusFallback={fallback} />));
      await settle();
      // Not on a hidden button, where it would be lost.
      expect(document.activeElement).toBe(document.body);
      menuButton.remove();
    });

    it("leaves focus alone after a Try again that fails again", async () => {
      setWidth(1280);
      mocks.switchOrganization
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false);
      mocks.organizations = TWO_ORGS;
      stubListMeasuring();
      const switcher = render();
      openList(switcher);
      await pick("Beta Corp");
      const options = mocks.toastError.mock.calls[0]?.[1] as {
        action: { onClick: () => void };
      };
      await act(async () => {
        options.action.onClick();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      // Focus nowhere: only a request left over would move it.
      (document.activeElement as HTMLElement | null)?.blur();
      // Some unrelated change of org later (a settings page, say).
      mocks.organization = { id: "org-2", name: "Beta Corp" };
      render();
      await settle();
      expect(document.activeElement).toBe(document.body);
    });

    it("announces a Try again on a quiet first switch", async () => {
      mocks.switchOrganization
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);
      mocks.organization = null;
      mocks.organizations = [{ id: "org-1", name: "Acme Labs" }];
      await act(async () => {
        root.render(<OrgSwitcher />);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(mocks.toastLoading).not.toHaveBeenCalled();
      const options = mocks.toastError.mock.calls[0]?.[1] as {
        action: { onClick: () => void };
      };
      await act(async () => {
        options.action.onClick();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(mocks.toastLoading).toHaveBeenCalledWith("Opening Acme Labs...");
    });
  });

  it("waits for the header to catch up before moving focus", async () => {
    // A 768-1023px window with a mouse: the header shows the switcher only
    // while it offers an org, so it hides once the org opens.
    function MouseTablet(): React.ReactElement {
      const offering = useSwitcherOffering();
      return (
        <div data-hidden={offering ? undefined : ""}>
          <OrgSwitcher />
        </div>
      );
    }
    HTMLElement.prototype.getClientRects = function (
      this: HTMLElement
    ): DOMRectList {
      return (this.closest("[data-hidden]")
        ? []
        : [new DOMRect(0, 0, 1, 1)]) as unknown as DOMRectList;
    };
    setWidth(900);
    let answer: (switched: boolean) => void = () => undefined;
    mocks.switchOrganization.mockResolvedValueOnce(false).mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      })
    );
    mocks.organization = null;
    mocks.organizations = [{ id: "org-1", name: "Acme Labs" }];
    await act(async () => {
      root.render(<MouseTablet />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    (document.activeElement as HTMLElement | null)?.blur();
    act(() => {
      container
        .querySelector<HTMLButtonElement>("[data-state=failed]")
        ?.click();
    });
    // As in the app: the org shows before the switch is done.
    mocks.organization = { id: "org-1", name: "Acme Labs" };
    act(() => root.render(<MouseTablet />));
    await act(async () => {
      answer(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await settle();
    // Not on the switcher, which hid as the org opened.
    expect(document.activeElement).toBe(document.body);
  });

  describe("loading the org again", () => {
    // No org shown, and the active org's request failed.
    function failToLoad(): void {
      mocks.organization = null;
      mocks.orgError = new Error("unavailable");
      mocks.organizations = [{ id: "org-1", name: "Acme Labs" }];
    }

    afterEach(() => {
      mocks.orgError = null;
    });

    it("opens the first org once it finds none active, never stuck on Loading", async () => {
      failToLoad();
      // The reload answers: no org active (it was deleted, say).
      mocks.refetchOrg.mockImplementationOnce(() => {
        mocks.orgError = null;
        return Promise.resolve();
      });
      act(() => root.render(<OrgSwitcher />));
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>("[data-state=failed]")
          ?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await settle();
      expect(mocks.switchOrganization).toHaveBeenCalledWith("org-1");
      // Its progress goes, not left spinning, and the org opened in its
      // place is said, as nothing else answers the load.
      const loading = mocks.toastLoading.mock.results[0]?.value;
      expect(mocks.toastDismiss).toHaveBeenCalledWith(loading);
      expect(mocks.toastLoading).toHaveBeenCalledWith("Opening Acme Labs...");
    });

    it("keeps the list's own Try again when its retry finds only the list failing", async () => {
      failToLoad();
      mocks.refetchOrg.mockResolvedValueOnce(undefined);
      act(() => root.render(<OrgSwitcher />));
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>("[data-state=failed]")
          ?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      const orgFailed = mocks.toastError.mock.calls[0]?.[1] as {
        action: { onClick: () => void };
      };
      // This time the org loads and only the list fails.
      mocks.refetchOrg.mockImplementationOnce(() => {
        mocks.orgError = null;
        mocks.organization = { id: "org-1", name: "Acme Labs" };
        return Promise.resolve();
      });
      mocks.reloadList.mockResolvedValueOnce(false);
      await act(async () => {
        orgFailed.action.onClick();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(mocks.toastError).toHaveBeenLastCalledWith(
        "Couldn't load your organizations.",
        expect.anything()
      );
      const listFailed = mocks.toastError.mock.calls.at(-1)?.[1] as {
        action: { onClick: () => void };
      };
      const before = mocks.reloadList.mock.calls.length;
      await act(async () => {
        listFailed.action.onClick();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      // It reloads the list for real.
      expect(mocks.reloadList).toHaveBeenCalledTimes(before + 1);
    });

    it("announces only the open that answers the load, not a later one", async () => {
      failToLoad();
      // The reload answers: none active.
      mocks.refetchOrg.mockImplementationOnce(() => {
        mocks.orgError = null;
        return Promise.resolve();
      });
      act(() => root.render(<OrgSwitcher />));
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>("[data-state=failed]")
          ?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await settle();
      expect(mocks.toastLoading).toHaveBeenCalledWith("Opening Acme Labs...");
      // It opened, and shows.
      mocks.organization = { id: "org-1", name: "Acme Labs" };
      act(() => root.render(<OrgSwitcher />));
      // Later the user is removed from it, with another org listed: the
      // switcher opens that one on its own, quietly.
      mocks.organization = null;
      mocks.organizations = [{ id: "org-2", name: "Beta Corp" }];
      act(() => root.render(<OrgSwitcher />));
      await settle();
      // The list, loaded afresh, arrives (a new answer).
      mocks.organizations = [...(mocks.organizations ?? [])];
      act(() => root.render(<OrgSwitcher />));
      await settle();
      expect(mocks.switchOrganization).toHaveBeenLastCalledWith("org-2");
      expect(mocks.toastLoading).not.toHaveBeenCalledWith(
        "Opening Beta Corp..."
      );
    });

    it("says nothing and opens nothing while the list fails, then announces the open", async () => {
      failToLoad();
      // The reload answers: none active, with an org listed.
      mocks.refetchOrg.mockImplementationOnce(() => {
        mocks.orgError = null;
        // The list fails again just after (another reload).
        mocks.listFailed = true;
        return Promise.resolve();
      });
      try {
        act(() => root.render(<OrgSwitcher />));
        await act(async () => {
          container
            .querySelector<HTMLButtonElement>("[data-state=failed]")
            ?.click();
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
        await settle();
        // Not that the user is in no org: the list is not known.
        expect(mocks.toastInfo).not.toHaveBeenCalled();
        expect(mocks.switchOrganization).not.toHaveBeenCalled();
        // The list loads: the open the load asked for, announced.
        mocks.listFailed = false;
        act(() => root.render(<OrgSwitcher />));
        await settle();
        expect(mocks.switchOrganization).toHaveBeenCalledWith("org-1");
        expect(mocks.toastLoading).toHaveBeenCalledWith("Opening Acme Labs...");
      } finally {
        mocks.listFailed = false;
      }
    });

    it("spends nothing while the list is still on its way", async () => {
      failToLoad();
      // The reload answers: none active; the list is reloading again.
      mocks.refetchOrg.mockImplementationOnce(() => {
        mocks.orgError = null;
        // As the real list reads while it loads: empty.
        mocks.orgsLoading = true;
        mocks.organizations = [];
        return Promise.resolve();
      });
      try {
        act(() => root.render(<OrgSwitcher />));
        await act(async () => {
          container
            .querySelector<HTMLButtonElement>("[data-state=failed]")
            ?.click();
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
        await settle();
        // Not that the user is in no org: the list is not here yet.
        expect(mocks.toastInfo).not.toHaveBeenCalled();
        // It arrives: the open the load asked for, announced.
        mocks.orgsLoading = false;
        mocks.organizations = [{ id: "org-1", name: "Acme Labs" }];
        act(() => root.render(<OrgSwitcher />));
        await settle();
        expect(mocks.toastLoading).toHaveBeenCalledWith("Opening Acme Labs...");
      } finally {
        mocks.orgsLoading = false;
      }
    });

    it("says the user is in no org even where one was offered, once none is listed", async () => {
      // A first open failed: the org is offered again.
      mocks.switchOrganization.mockResolvedValueOnce(false);
      mocks.organization = null;
      mocks.organizations = [{ id: "org-1", name: "Acme Labs" }];
      await act(async () => {
        root.render(<OrgSwitcher />);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      // Then the active org fails to load; Load finds none active and the
      // list empty: the offer is stale.
      mocks.orgError = new Error("unavailable");
      act(() => root.render(<OrgSwitcher />));
      mocks.refetchOrg.mockImplementationOnce(() => {
        mocks.orgError = null;
        mocks.organizations = [];
        return Promise.resolve();
      });
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>("[data-state=failed]")
          ?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await settle();
      expect(mocks.toastInfo).toHaveBeenCalledWith(
        "You're no longer in any organization.",
        expect.anything()
      );
    });

    it("never tells a user with no orgs anything without a load they asked for", async () => {
      mocks.organization = null;
      mocks.organizations = [];
      await act(async () => {
        root.render(<OrgSwitcher />);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await settle();
      expect(
        container.querySelector("[data-state]")?.getAttribute("data-state")
      ).toBe("create");
      expect(mocks.toastInfo).not.toHaveBeenCalled();
    });

    it("spends the announcement silently where an org is offered", async () => {
      // A first open failed: the org is offered again.
      mocks.switchOrganization.mockResolvedValueOnce(false);
      mocks.organization = null;
      mocks.organizations = [{ id: "org-1", name: "Acme Labs" }];
      await act(async () => {
        root.render(<OrgSwitcher />);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      // Then the active org fails to load, and Load finds none active.
      mocks.orgError = new Error("unavailable");
      act(() => root.render(<OrgSwitcher />));
      mocks.refetchOrg.mockImplementationOnce(() => {
        mocks.orgError = null;
        return Promise.resolve();
      });
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>("[data-state=failed]")
          ?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await settle();
      // The user is in an org (offered again): nothing says otherwise.
      expect(mocks.toastInfo).not.toHaveBeenCalled();
    });

    it("says when a load finds no org and none to open, and keeps nothing for later", async () => {
      failToLoad();
      // The reload answers: none active, and no orgs left.
      mocks.refetchOrg.mockImplementationOnce(() => {
        mocks.orgError = null;
        mocks.organizations = [];
        return Promise.resolve();
      });
      act(() => root.render(<OrgSwitcher />));
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>("[data-state=failed]")
          ?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await settle();
      expect(mocks.toastInfo).toHaveBeenCalledWith(
        "You're no longer in any organization.",
        expect.anything()
      );
      // Later an org is listed (an invitation accepted), none active: the
      // switcher opens it on its own, quietly.
      mocks.organizations = [{ id: "org-2", name: "Invited Co" }];
      act(() => root.render(<OrgSwitcher />));
      await settle();
      expect(mocks.switchOrganization).toHaveBeenLastCalledWith("org-2");
      expect(mocks.toastLoading).not.toHaveBeenCalledWith(
        "Opening Invited Co..."
      );
    });

    it("spends the announcement when it opens none, so a later open is quiet", async () => {
      failToLoad();
      // The reload answers: none active, and no orgs left to open.
      mocks.refetchOrg.mockImplementationOnce(() => {
        mocks.orgError = null;
        mocks.organizations = [];
        return Promise.resolve();
      });
      act(() => root.render(<OrgSwitcher />));
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>("[data-state=failed]")
          ?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await settle();
      // An org becomes active another way (the user creates one).
      mocks.organization = { id: "org-1", name: "Acme Labs" };
      mocks.organizations = [{ id: "org-1", name: "Acme Labs" }];
      act(() => root.render(<OrgSwitcher />));
      // Later the user is removed from it, another org listed.
      mocks.organization = null;
      mocks.organizations = [{ id: "org-2", name: "Beta Corp" }];
      act(() => root.render(<OrgSwitcher />));
      await settle();
      // The list, loaded afresh, arrives (a new answer).
      mocks.organizations = [...(mocks.organizations ?? [])];
      act(() => root.render(<OrgSwitcher />));
      await settle();
      expect(mocks.switchOrganization).toHaveBeenLastCalledWith("org-2");
      expect(mocks.toastLoading).not.toHaveBeenCalledWith(
        "Opening Beta Corp..."
      );
    });

    it("fails when the org fails again, and its Try again loads again", async () => {
      failToLoad();
      // Still no answer for the org.
      mocks.refetchOrg.mockResolvedValueOnce(undefined);
      act(() => root.render(<OrgSwitcher />));
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>("[data-state=failed]")
          ?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(mocks.toastSuccess).not.toHaveBeenCalled();
      expect(mocks.toastError.mock.calls[0]?.[0]).toBe(
        "Couldn't load your organization."
      );
      const options = mocks.toastError.mock.calls[0]?.[1] as {
        action: { onClick: () => void };
      };
      mocks.refetchOrg.mockImplementationOnce(() => {
        mocks.orgError = null;
        mocks.organization = { id: "org-1", name: "Acme Labs" };
        return Promise.resolve();
      });
      await act(async () => {
        options.action.onClick();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(mocks.refetchOrg).toHaveBeenCalledTimes(2);
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        "Loaded your organization",
        expect.anything()
      );
    });

    it("says only the list failed once the org shows, with the list's Try again", async () => {
      failToLoad();
      // The org loads; the list does not.
      mocks.refetchOrg.mockImplementationOnce(() => {
        mocks.orgError = null;
        mocks.organization = { id: "org-1", name: "Acme Labs" };
        return Promise.resolve();
      });
      mocks.reloadList.mockResolvedValueOnce(false);
      setWidth(1280);
      act(() => root.render(<OrgSwitcher />));
      (document.activeElement as HTMLElement | null)?.blur();
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>("[data-state=failed]")
          ?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      // Its progress goes, not left spinning.
      const loading = mocks.toastLoading.mock.results[0]?.value;
      expect(mocks.toastDismiss).toHaveBeenCalledWith(loading);
      // The org it loaded shows: focus goes to the switcher.
      act(() => root.render(<OrgSwitcher />));
      await settle();
      expect(document.activeElement).toBe(
        container.querySelector("[data-testid=org-switcher]")
      );
      // Not that the org (on screen) failed: the list did.
      expect(mocks.toastError).not.toHaveBeenCalledWith(
        "Couldn't load your organization.",
        expect.anything()
      );
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Couldn't load your organizations.",
        expect.anything()
      );
      const options = mocks.toastError.mock.calls[0]?.[1] as {
        action: { onClick: () => void };
      };
      await act(async () => {
        options.action.onClick();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      // It loads the list again, not the org.
      expect(mocks.reloadList).toHaveBeenCalledTimes(2);
      expect(mocks.refetchOrg).toHaveBeenCalledTimes(1);
    });

    it("puts focus on the switcher for the org opened after a load that found none", async () => {
      failToLoad();
      // The reload answers: none active.
      mocks.refetchOrg.mockImplementationOnce(() => {
        mocks.orgError = null;
        return Promise.resolve();
      });
      act(() => root.render(<OrgSwitcher />));
      (document.activeElement as HTMLElement | null)?.blur();
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>("[data-state=failed]")
          ?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      // Nothing to say it loaded: the org opened in its place is said.
      expect(mocks.toastSuccess).not.toHaveBeenCalledWith(
        "Loaded your organization",
        expect.anything()
      );
      mocks.organization = { id: "org-1", name: "Acme Labs" };
      act(() => root.render(<OrgSwitcher />));
      await settle();
      // The Load button that had focus is gone: focus goes to the switcher.
      expect(document.activeElement).toBe(
        container.querySelector("[data-testid=org-switcher]")
      );
    });

    it("skips its Try again once an org shows some other way", async () => {
      failToLoad();
      mocks.refetchOrg.mockResolvedValueOnce(undefined);
      act(() => root.render(<OrgSwitcher />));
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>("[data-state=failed]")
          ?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      const options = mocks.toastError.mock.calls[0]?.[1] as {
        action: { onClick: () => void };
      };
      mocks.orgError = null;
      mocks.organization = { id: "org-1", name: "Acme Labs" };
      act(() => root.render(<OrgSwitcher />));
      await act(async () => {
        options.action.onClick();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(mocks.refetchOrg).toHaveBeenCalledOnce();
    });

    it("puts focus on the switcher after its failure toast's Try again works", async () => {
      setWidth(1280);
      failToLoad();
      mocks.refetchOrg.mockResolvedValueOnce(undefined);
      mocks.toastError.mockReturnValueOnce("toast-failed");
      act(() => root.render(<OrgSwitcher />));
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>("[data-state=failed]")
          ?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      const options = mocks.toastError.mock.calls[0]?.[1] as {
        action: { onClick: () => void };
      };
      // The toast held focus, and goes.
      (document.activeElement as HTMLElement | null)?.blur();
      mocks.refetchOrg.mockImplementationOnce(() => {
        mocks.orgError = null;
        mocks.organization = { id: "org-1", name: "Acme Labs" };
        return Promise.resolve();
      });
      await act(async () => {
        options.action.onClick();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      // The failure it answers is cleared as it starts.
      expect(mocks.toastDismiss).toHaveBeenCalledWith("toast-failed");
      act(() => root.render(<OrgSwitcher />));
      await settle();
      expect(document.activeElement).toBe(
        container.querySelector("[data-testid=org-switcher]")
      );
    });

    it("closes the menu, so its result can be reached, when loading from it", async () => {
      failToLoad();
      const onPick = vi.fn();
      act(() =>
        root.render(<OrgSwitcher menu={{ disabled: false, onPick }} />)
      );
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>("[data-state=failed]")
          ?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(onPick).toHaveBeenCalledWith(true);
    });

    it("counts a load that throws as failed", async () => {
      failToLoad();
      mocks.refetchOrg.mockRejectedValueOnce(new Error("offline"));
      const log = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      try {
        act(() => root.render(<OrgSwitcher />));
        await act(async () => {
          container
            .querySelector<HTMLButtonElement>("[data-state=failed]")
            ?.click();
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
        expect(mocks.toastError).toHaveBeenCalledWith(
          "Couldn't load your organization.",
          expect.anything()
        );
      } finally {
        log.mockRestore();
      }
    });

    it("stays busy and focusable while it loads, and holds other switches", async () => {
      failToLoad();
      let loaded: () => void = () => undefined;
      mocks.refetchOrg.mockReturnValueOnce(
        new Promise<void>((resolve) => {
          loaded = resolve;
        })
      );
      act(() => root.render(<OrgSwitcher />));
      const button = container.querySelector<HTMLButtonElement>(
        "[data-state=failed]"
      );
      act(() => {
        button?.focus();
        button?.click();
      });
      const during = container.querySelector<HTMLButtonElement>(
        "[data-state=failed]"
      );
      expect(during?.getAttribute("aria-busy")).toBe("true");
      expect(during?.disabled).toBe(false);
      expect(document.activeElement).toBe(during);
      expect(
        await runOrgSwitch({
          orgId: "org-1",
          name: "Acme Labs",
          start: () => Promise.resolve(true),
          announce: false,
        })
      ).toBeNull();
      await act(async () => {
        loaded();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    });

    it("is marked busy while another switch runs, as a click would do nothing", async () => {
      failToLoad();
      let done: () => void = () => undefined;
      const held = holdOrgSwitching(
        () =>
          new Promise<void>((resolve) => {
            done = resolve;
          })
      );
      act(() => root.render(<OrgSwitcher />));
      expect(
        container
          .querySelector("[data-state=failed]")
          ?.getAttribute("aria-busy")
      ).toBe("true");
      await act(async () => {
        done();
        await held;
      });
    });

    it("leaves focus be after a failed load, when an org shows later", async () => {
      failToLoad();
      mocks.reloadList.mockResolvedValueOnce(false);
      act(() => root.render(<OrgSwitcher />));
      (document.activeElement as HTMLElement | null)?.blur();
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>("[data-state=failed]")
          ?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      // Later, an org shows some other way, with focus nowhere.
      mocks.orgError = null;
      mocks.organization = { id: "org-1", name: "Acme Labs" };
      act(() => root.render(<OrgSwitcher />));
      await settle();
      expect(document.activeElement).toBe(document.body);
    });
  });

  describe("offering to try again, for a header that hides it", () => {
    let offering: boolean | null = null;
    function Reader(): null {
      offering = useSwitcherOffering();
      return null;
    }

    afterEach(() => {
      mocks.orgError = null;
    });

    it("offers while the active org could not be loaded, and while it loads", async () => {
      mocks.organization = null;
      mocks.orgError = new Error("unavailable");
      let loaded: () => void = () => undefined;
      mocks.refetchOrg.mockReturnValueOnce(
        new Promise<void>((resolve) => {
          loaded = resolve;
        })
      );
      const tree = (
        <>
          <OrgSwitcher />
          <Reader />
        </>
      );
      act(() => root.render(tree));
      expect(offering).toBe(true);
      act(() => {
        container
          .querySelector<HTMLButtonElement>("[data-state=failed]")
          ?.click();
      });
      expect(offering).toBe(true);
      await act(async () => {
        loaded();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    });

    it("is the header's alone, and ends when it goes", () => {
      mocks.organization = null;
      mocks.orgError = new Error("unavailable");
      act(() =>
        root.render(
          <>
            <OrgSwitcher menu={{ disabled: false, onPick: vi.fn() }} />
            <Reader />
          </>
        )
      );
      // The menu's switcher does not show the header's.
      expect(offering).toBe(false);
      act(() =>
        root.render(
          <>
            <OrgSwitcher />
            <Reader />
          </>
        )
      );
      expect(offering).toBe(true);
      act(() => root.render(<Reader />));
      expect(offering).toBe(false);
    });
  });
});
