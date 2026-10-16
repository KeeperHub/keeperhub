// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  params: { orgId: "org-2" } as { orgId?: string },
  // One array, as the app's list keeps between renders: a new one each
  // render would re-run the switch effect and hide a missing dependency.
  organizations: [
    { id: "org-1", name: "Acme", role: "owner" },
    { id: "org-2", name: "Beta", role: "owner" },
  ],
  orgsLoading: false,
  listFailed: false,
  reloadList: vi.fn(() => Promise.resolve(true)),
  replace: vi.fn(),
  switchOrganization: vi.fn(),
  error: vi.fn(),
  loading: vi.fn(() => "toast-loading"),
  dismiss: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useParams: () => mocks.params,
  useRouter: () => ({ replace: mocks.replace }),
}));
vi.mock("sonner", () => ({
  toast: {
    error: mocks.error,
    success: vi.fn(),
    loading: mocks.loading,
    dismiss: mocks.dismiss,
  },
}));
vi.mock("@/lib/hooks/use-organization", () => ({
  currentActiveOrgId: () => "org-1",
  useOrganization: () => ({
    organization: { id: "org-1", name: "Acme" },
    isLoading: false,
    switchOrganization: mocks.switchOrganization,
  }),
  useActiveMember: () => ({ role: "owner", isLoading: false }),
  useOrganizations: () => ({
    organizations: mocks.listFailed ? [] : mocks.organizations,
    isLoading: mocks.orgsLoading,
    hasError: mocks.listFailed,
    reload: mocks.reloadList,
  }),
}));

import {
  holdOrgSwitching,
  resetOrgSwitchState,
} from "@/components/organization/org-switch-runner";
import {
  SettingsProvider,
  useSettingsContext,
} from "@/components/settings/hub/settings-context";

let container: HTMLDivElement;
let root: Root;

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

async function renderSettings(): Promise<void> {
  await act(async () => {
    root.render(<SettingsProvider>{null}</SettingsProvider>);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetOrgSwitchState();
  mocks.params = { orgId: "org-2" };
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

describe("SettingsProvider's switch to the URL's organization", () => {
  it("switches to the organization a settings link is for", async () => {
    mocks.switchOrganization.mockResolvedValueOnce(true);
    await renderSettings();
    expect(mocks.switchOrganization).toHaveBeenCalledOnce();
    expect(mocks.switchOrganization).toHaveBeenCalledWith("org-2");
  });

  it("says so, with Try again, when that fails", async () => {
    mocks.switchOrganization.mockResolvedValueOnce(false);
    await renderSettings();
    expect(mocks.error).toHaveBeenCalledWith(
      "Couldn't switch to Beta.",
      expect.objectContaining({
        action: expect.objectContaining({ label: "Try again" }),
      })
    );
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
    await renderSettings();
    expect(mocks.switchOrganization).not.toHaveBeenCalled();
    await act(async () => {
      done();
      await held;
    });
    expect(mocks.switchOrganization).toHaveBeenCalledWith("org-2");
  });

  it("does nothing when the URL's organization is the active one", async () => {
    mocks.params = { orgId: "org-1" };
    await renderSettings();
    expect(mocks.switchOrganization).not.toHaveBeenCalled();
  });

  it("waits for the list, which names the org", async () => {
    mocks.orgsLoading = true;
    mocks.switchOrganization.mockResolvedValueOnce(false);
    await renderSettings();
    expect(mocks.switchOrganization).not.toHaveBeenCalled();
    mocks.orgsLoading = false;
    await renderSettings();
    expect(mocks.error).toHaveBeenCalledWith(
      "Couldn't switch to Beta.",
      expect.anything()
    );
  });

  it("says so, with no Try again, for an org the user is not in", async () => {
    mocks.params = { orgId: "org-gone" };
    await renderSettings();
    expect(mocks.switchOrganization).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledWith(
      "You're not a member of that organization.",
      expect.objectContaining({ duration: 12_000, action: undefined })
    );
    // Not left on a page for an org the user is not in.
    expect(mocks.replace).toHaveBeenCalledWith("/settings");
  });

  it("says the list failed, not that the user is not a member, and waits", async () => {
    mocks.listFailed = true;
    mocks.switchOrganization.mockResolvedValueOnce(true);
    await renderSettings();
    expect(mocks.switchOrganization).not.toHaveBeenCalled();
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledWith(
      "Couldn't load your organizations.",
      expect.objectContaining({
        action: expect.objectContaining({ label: "Try again" }),
      })
    );
    const options = mocks.error.mock.calls[0]?.[1] as {
      action: { onClick: () => void };
    };
    // Its Try again fails too: said again, with Try again.
    mocks.reloadList.mockResolvedValueOnce(false);
    await act(async () => {
      options.action.onClick();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mocks.loading).toHaveBeenCalledWith("Loading your organizations...");
    expect(mocks.error).toHaveBeenCalledTimes(2);
    const again = mocks.error.mock.calls[1]?.[1] as {
      action: { onClick: () => void };
    };
    await act(async () => {
      again.action.onClick();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mocks.reloadList).toHaveBeenCalledTimes(2);
    expect(mocks.error).toHaveBeenCalledTimes(2);
    // Each Try again's progress goes: for the failure said again, then for
    // the list that loaded.
    expect(
      mocks.dismiss.mock.calls.filter(([id]) => id === "toast-loading")
    ).toHaveLength(2);
    // The list loads: the link switches after all.
    mocks.listFailed = false;
    await renderSettings();
    expect(mocks.switchOrganization).toHaveBeenCalledWith("org-2");
  });

  it("never borrows the active org's role for another org a link names", async () => {
    // Owner of the active org (the active membership), not in org-gone.
    mocks.params = { orgId: "org-gone" };
    let isOwner: boolean | null = null;
    function Reader(): null {
      isOwner = useSettingsContext().isOwner;
      return null;
    }
    await act(async () => {
      root.render(
        <SettingsProvider>
          <Reader />
        </SettingsProvider>
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(isOwner).toBe(false);
  });

  it("tries again when a switch took the lock in the same render", async () => {
    mocks.switchOrganization.mockResolvedValue(true);
    let firstDone: () => void = () => undefined;
    // Takes the lock in the render `take` turns on, its effect running
    // before the provider's (an earlier sibling, as the header's switcher is).
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
    // One tree throughout, so the provider is not mounted afresh.
    const tree = (take: boolean): React.ReactElement => (
      <>
        <First take={take} />
        <SettingsProvider>{null}</SettingsProvider>
      </>
    );
    mocks.orgsLoading = true;
    await act(async () => {
      root.render(tree(false));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // The list arrives, and in the same render a switch takes the lock first.
    mocks.orgsLoading = false;
    await act(async () => {
      root.render(tree(true));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mocks.switchOrganization).not.toHaveBeenCalled();
    await act(async () => {
      firstDone();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mocks.switchOrganization).toHaveBeenCalledWith("org-2");
  });
});
