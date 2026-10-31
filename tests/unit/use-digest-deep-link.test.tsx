// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Org = { id: string; name: string };

const mocks = vi.hoisted(() => ({
  search: "digestSettings=org-2",
  organization: { id: "org-1", name: "Acme" } as Org | null,
  orgLoading: false,
  orgsLoading: false,
  // One array, as the app's list keeps between renders.
  organizations: [
    { id: "org-1", name: "Acme" },
    { id: "org-2", name: "Beta" },
  ] as Org[],
  switchOrganization: vi.fn(),
  // The org the auth client holds once a switch has shown it.
  serverOrg: undefined as string | undefined,
  listFailed: false,
  reloadList: vi.fn(() => Promise.resolve(true)),
  error: vi.fn(),
  loading: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(mocks.search),
}));
vi.mock("sonner", () => ({
  toast: {
    error: mocks.error,
    success: vi.fn(),
    loading: mocks.loading,
    dismiss: vi.fn(),
  },
}));
// A switch that took, as the app's resolves: once its org is the one shown.
async function switchShowing(orgId: string): Promise<boolean> {
  const switched = await mocks.switchOrganization(orgId);
  if (switched) {
    mocks.serverOrg = orgId;
  }
  return switched;
}

vi.mock("@/lib/hooks/use-organization", () => ({
  currentActiveOrgId: () => mocks.serverOrg ?? mocks.organization?.id,
  useOrganization: () => ({
    organization: mocks.organization,
    isLoading: mocks.orgLoading,
    switchOrganization: switchShowing,
  }),
  useOrganizations: () => ({
    organizations: mocks.listFailed ? [] : mocks.organizations,
    isLoading: mocks.orgsLoading,
    hasError: mocks.listFailed,
    reload: mocks.reloadList,
  }),
}));

import {
  holdOrgSwitching,
  noteActiveOrg,
  resetOrgSwitchState,
} from "@/components/organization/org-switch-runner";
import { useDigestSettingsOpener } from "@/components/organization/use-digest-deep-link";

let container: HTMLDivElement;
let root: Root;
const onReady = vi.fn();

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let enabled = true;

// The dialog's side: `onReady` stands for its opening.
function Probe(): null {
  useDigestSettingsOpener({
    enabled,
    setOpen: (open) => {
      if (open) {
        onReady();
      }
    },
    setActiveTab: () => undefined,
  });
  return null;
}

// Followed the link to this page.
function arrive(search: string): void {
  mocks.search = search;
  window.history.replaceState(null, "", `/workflows?${search}`);
}

function urlHasParam(): boolean {
  return new URL(window.location.href).searchParams.has("digestSettings");
}

async function render(): Promise<void> {
  await act(async () => {
    root.render(<Probe />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetOrgSwitchState();
  mocks.serverOrg = undefined;
  noteActiveOrg("org-1");
  enabled = true;
  arrive("digestSettings=org-2");
  mocks.organization = { id: "org-1", name: "Acme" };
  mocks.orgLoading = false;
  mocks.orgsLoading = false;
  mocks.listFailed = false;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("the digest link", () => {
  it("opens at once on the org already active, without switching", async () => {
    mocks.search = "digestSettings=org-1";
    await render();
    expect(mocks.switchOrganization).not.toHaveBeenCalled();
    expect(onReady).toHaveBeenCalledOnce();
  });

  it("switches, and opens once the switch is made", async () => {
    mocks.switchOrganization.mockResolvedValueOnce(true);
    await render();
    expect(mocks.switchOrganization).toHaveBeenCalledWith("org-2");
    expect(mocks.loading).toHaveBeenCalledWith("Switching to Beta...");
    expect(onReady).toHaveBeenCalledOnce();
    // Done with: the org showing does not open it again.
    mocks.organization = { id: "org-2", name: "Beta" };
    await render();
    expect(onReady).toHaveBeenCalledOnce();
  });

  it("names the org when the switch fails, and opens after a Try again that works", async () => {
    mocks.switchOrganization
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    await render();
    expect(onReady).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledWith(
      "Couldn't switch to Beta.",
      expect.anything()
    );
    const options = mocks.error.mock.calls[0]?.[1] as {
      action: { onClick: () => void };
    };
    await act(async () => {
      options.action.onClick();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    mocks.organization = { id: "org-2", name: "Beta" };
    await render();
    expect(onReady).toHaveBeenCalledOnce();
  });

  it("waits for the active org and the list to load", async () => {
    mocks.orgLoading = true;
    mocks.orgsLoading = true;
    mocks.search = "digestSettings=org-1";
    await render();
    expect(onReady).not.toHaveBeenCalled();
    mocks.orgLoading = false;
    mocks.orgsLoading = false;
    await render();
    expect(mocks.switchOrganization).not.toHaveBeenCalled();
    expect(onReady).toHaveBeenCalledOnce();
  });

  it("waits for a switch already running, then switches", async () => {
    let done: () => void = () => undefined;
    const held = holdOrgSwitching(
      () =>
        new Promise<void>((resolve) => {
          done = resolve;
        })
    );
    mocks.switchOrganization.mockResolvedValueOnce(true);
    await render();
    expect(mocks.switchOrganization).not.toHaveBeenCalled();
    await act(async () => {
      done();
      await held;
    });
    expect(mocks.switchOrganization).toHaveBeenCalledWith("org-2");
  });

  it("says so for an org the user is not in, and never opens", async () => {
    mocks.search = "digestSettings=org-gone";
    await render();
    expect(mocks.switchOrganization).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledWith(
      "You're not a member of that organization.",
      expect.objectContaining({ duration: 12_000, action: undefined })
    );
    expect(onReady).not.toHaveBeenCalled();
  });

  it("waits for the active org alone to load", async () => {
    mocks.orgLoading = true;
    arrive("digestSettings=org-1");
    await render();
    expect(onReady).not.toHaveBeenCalled();
    mocks.orgLoading = false;
    await render();
    expect(onReady).toHaveBeenCalledOnce();
  });

  it("waits for the list alone to load", async () => {
    mocks.orgsLoading = true;
    await render();
    expect(mocks.switchOrganization).not.toHaveBeenCalled();
    mocks.orgsLoading = false;
    mocks.switchOrganization.mockResolvedValueOnce(true);
    await render();
    expect(mocks.switchOrganization).toHaveBeenCalledWith("org-2");
  });

  it("keeps the param until it is done, then takes it off the URL", async () => {
    let answer: (switched: boolean) => void = () => undefined;
    mocks.switchOrganization.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      })
    );
    await render();
    // Until the switch is done, the link is still on the URL.
    expect(urlHasParam()).toBe(true);
    await act(async () => {
      answer(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(urlHasParam()).toBe(false);
  });

  it("is let go after a failed switch: the org showing later opens nothing", async () => {
    mocks.switchOrganization.mockResolvedValueOnce(false);
    await render();
    expect(urlHasParam()).toBe(false);
    // The user ignores Try again and gets to the org another way, later.
    mocks.organization = { id: "org-2", name: "Beta" };
    await render();
    expect(onReady).not.toHaveBeenCalled();
  });

  it("is let go after an org the user is not in", async () => {
    arrive("digestSettings=org-gone");
    await render();
    expect(urlHasParam()).toBe(false);
    mocks.organizations = [...mocks.organizations];
    await render();
    expect(mocks.error).toHaveBeenCalledOnce();
  });

  it("tries again when a switch took the lock in the same render", async () => {
    // No org active: the header switcher opens one first, in the same render.
    mocks.switchOrganization.mockResolvedValue(true);
    let firstDone: () => void = () => undefined;
    // Takes the lock in the render `take` turns on, its effect running
    // before the link's (an earlier sibling, as the header's switcher is).
    function First({ take }: { take: boolean }): null {
      useEffect(() => {
        if (take) {
          holdOrgSwitching(
            () =>
              new Promise<void>((resolve) => {
                firstDone = resolve;
              })
          );
        }
      }, [take]);
      return null;
    }
    // One tree throughout, so the link's component is not mounted afresh.
    const tree = (take: boolean): React.ReactElement => (
      <>
        <First take={take} />
        <Probe />
      </>
    );
    // The link is read while the list loads.
    mocks.orgsLoading = true;
    await act(async () => {
      root.render(tree(false));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // The list arrives, and in the same render the switcher takes the lock,
    // its effect running before the link's.
    mocks.orgsLoading = false;
    await act(async () => {
      root.render(tree(true));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mocks.switchOrganization).not.toHaveBeenCalled();
    // Not let go: it waits for that switch.
    expect(urlHasParam()).toBe(true);
    await act(async () => {
      firstDone();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mocks.switchOrganization).toHaveBeenCalledWith("org-2");
    expect(onReady).toHaveBeenCalledOnce();
  });

  it("says the list failed, not that the user is not in the org, and waits", async () => {
    mocks.listFailed = true;
    mocks.switchOrganization.mockResolvedValueOnce(true);
    await render();
    expect(mocks.switchOrganization).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledWith(
      "Couldn't load your organizations.",
      expect.objectContaining({
        action: expect.objectContaining({ label: "Try again" }),
      })
    );
    // Let go: the page under it does not wait on it.
    expect(urlHasParam()).toBe(false);
    // The list loads some other way later: the link does not follow itself.
    mocks.listFailed = false;
    await render();
    expect(mocks.switchOrganization).not.toHaveBeenCalled();
    const options = mocks.error.mock.calls[0]?.[1] as {
      action: { onClick: () => void };
    };
    // Its Try again fails too: said again, the link not followed.
    mocks.reloadList.mockResolvedValueOnce(false);
    await act(async () => {
      options.action.onClick();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mocks.reloadList).toHaveBeenCalledOnce();
    expect(mocks.error).toHaveBeenCalledTimes(2);
    await render();
    expect(mocks.switchOrganization).not.toHaveBeenCalled();
    // The second Try again loads the list, and follows the link.
    const again = mocks.error.mock.calls[1]?.[1] as {
      action: { onClick: () => void };
    };
    await act(async () => {
      again.action.onClick();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mocks.reloadList).toHaveBeenCalledTimes(2);
    await render();
    expect(mocks.switchOrganization).toHaveBeenCalledWith("org-2");
    expect(onReady).toHaveBeenCalledOnce();
  });

  it("does nothing where it is not enabled", async () => {
    enabled = false;
    arrive("digestSettings=org-1");
    await render();
    expect(onReady).not.toHaveBeenCalled();
    expect(urlHasParam()).toBe(true);
  });
});

describe("useDigestSettingsOpener", () => {
  it("opens the settings on the Notifications tab once its org is active", async () => {
    const setOpen = vi.fn();
    const setActiveTab = vi.fn();
    function Opener(): null {
      useDigestSettingsOpener({ enabled: true, setOpen, setActiveTab });
      return null;
    }
    arrive("digestSettings=org-1");
    await act(async () => {
      root.render(<Opener />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(setActiveTab).toHaveBeenCalledWith("notifications");
    expect(setOpen).toHaveBeenCalledWith(true);
  });

  it("does nothing for a dialog that does not take the link", async () => {
    const setOpen = vi.fn();
    function Opener(): null {
      useDigestSettingsOpener({
        enabled: false,
        setOpen,
        setActiveTab: vi.fn(),
      });
      return null;
    }
    arrive("digestSettings=org-1");
    await act(async () => {
      root.render(<Opener />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(setOpen).not.toHaveBeenCalled();
  });
});
