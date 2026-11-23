import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  loading: vi.fn(() => "toast-loading"),
  refetchOrganizations: vi.fn(),
  dismiss: vi.fn(),
  // The active org as the auth client holds it.
  activeOrgId: undefined as string | undefined,
}));

vi.mock("@/lib/hooks/use-organization", () => ({
  currentActiveOrgId: () => mocks.activeOrgId,
}));

vi.mock("@/lib/refetch-organizations", () => ({
  refetchOrganizations: mocks.refetchOrganizations,
}));

vi.mock("sonner", () => ({
  toast: {
    success: mocks.success,
    error: mocks.error,
    loading: mocks.loading,
    dismiss: mocks.dismiss,
  },
}));

import {
  noteActiveOrg,
  reportLinkProblem,
  resetOrgSwitchState,
  runOrgLoad,
  runOrgSwitch,
  takeOpenAnnouncement,
} from "@/components/organization/org-switch-runner";
import { switchAwayFrom } from "@/components/organization/switch-away";

const ACME = { id: "org-1", name: "Acme" };
const BETA = { id: "org-2", name: "Beta" };

// A switch that took, as the app's resolves: once its org is the one shown.
function shows(orgId: string): Promise<boolean> {
  mocks.activeOrgId = orgId;
  return Promise.resolve(true);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetOrgSwitchState();
  mocks.activeOrgId = undefined;
});

function run(switchOrganization: (orgId: string) => Promise<boolean>) {
  const goHome = vi.fn();
  const done = switchAwayFrom({
    removed: ACME,
    wasActive: true,
    organizations: [ACME, BETA],
    done: "Left",
    switchOrganization,
    goHome,
  });
  return { done, goHome };
}

describe("switchAwayFrom", () => {
  it("opens another organization and says where", async () => {
    const switchOrganization = vi.fn(shows);
    const { done, goHome } = run(switchOrganization);
    await done;
    // From the page shown: no caller here is leaving it.
    expect(switchOrganization).toHaveBeenCalledWith("org-2", undefined);
    expect(mocks.success).toHaveBeenCalledWith("Left Acme. Now in Beta.");
    expect(goHome).not.toHaveBeenCalled();
  });

  it("says it left, and that the page is behind, when it could not show the org it opened", async () => {
    // The server took the switch; the page still shows none.
    const { done, goHome } = run(() => Promise.resolve(true));
    await done;
    expect(mocks.success).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledWith(
      "Left Acme. Now in Beta, but couldn't update the page.",
      expect.objectContaining({
        action: expect.objectContaining({ label: "Reload" }),
      })
    );
    expect(goHome).not.toHaveBeenCalled();
  });

  it("goes home and says what to do when that fails", async () => {
    const { done, goHome } = run(() => Promise.resolve(false));
    await done;
    expect(mocks.error).toHaveBeenCalledWith(
      "Left Acme, but couldn't open Beta.",
      expect.objectContaining({
        duration: 12_000,
        action: expect.objectContaining({ label: "Try again" }),
      })
    );
    expect(goHome).toHaveBeenCalledOnce();
    expect(mocks.success).not.toHaveBeenCalled();
    // Leaving cleared the session's org, which the page has not heard.
    expect(mocks.refetchOrganizations).toHaveBeenCalledOnce();
  });

  it("leaves reloading the org to a delete, which tells the page itself", async () => {
    await switchAwayFrom({
      removed: ACME,
      wasActive: true,
      organizations: [ACME, BETA],
      done: "Deleted",
      switchOrganization: () => Promise.resolve(false),
    });
    expect(mocks.refetchOrganizations).not.toHaveBeenCalled();
  });

  it("treats a switch that throws as one that failed, and logs why", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const error = new Error("offline");
    try {
      const { done, goHome } = run(() => Promise.reject(error));
      await done;
      expect(goHome).toHaveBeenCalledOnce();
      expect(log).toHaveBeenCalledWith(expect.any(String), error);
    } finally {
      log.mockRestore();
    }
  });

  it("only says what was done when there is nowhere else to go", async () => {
    const switchOrganization = vi.fn(shows);
    await switchAwayFrom({
      removed: ACME,
      wasActive: true,
      organizations: [ACME],
      done: "Deleted",
      switchOrganization,
      goHome: vi.fn(),
    });
    expect(switchOrganization).not.toHaveBeenCalled();
    expect(mocks.success).toHaveBeenCalledWith("Deleted Acme");
  });

  it("keeps the org switchers from switching while it does", async () => {
    let fromSwitcher: Promise<boolean | null> = Promise.resolve(false);
    const { done } = run(() => {
      // A pick in a switcher meanwhile does not run.
      fromSwitcher = runOrgSwitch({
        orgId: "org-2",
        name: "Beta",
        start: () => Promise.resolve(true),
        announce: false,
      });
      return Promise.resolve(true);
    });
    await done;
    expect(await fromSwitcher).toBeNull();
  });

  it("needs no way home, for a caller already leaving the page", async () => {
    await expect(
      switchAwayFrom({
        removed: ACME,
        wasActive: true,
        organizations: [ACME, BETA],
        done: "Left",
        switchOrganization: () => Promise.resolve(false),
      })
    ).resolves.toBeUndefined();
    expect(mocks.error).toHaveBeenCalledOnce();
  });

  it("tries opening the other organization again from its toast", async () => {
    const switchOrganization = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockImplementationOnce(shows);
    await switchAwayFrom({
      removed: ACME,
      wasActive: true,
      organizations: [ACME, BETA],
      done: "Left",
      switchOrganization,
    });
    const options = mocks.error.mock.calls[0]?.[1] as {
      action: { onClick: () => void };
    };
    options.action.onClick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(switchOrganization).toHaveBeenLastCalledWith("org-2");
    expect(switchOrganization).toHaveBeenCalledTimes(2);
    // Nothing on screen names the org it opens, so it says.
    expect(mocks.loading).toHaveBeenCalledWith("Opening Beta...");
    expect(mocks.success).toHaveBeenCalledWith("Opened Beta", {
      id: "toast-loading",
    });
  });

  it("only says what was done when the org was not the active one", async () => {
    const switchOrganization = vi.fn(shows);
    await switchAwayFrom({
      removed: ACME,
      wasActive: false,
      organizations: [ACME, BETA],
      done: "Left",
      switchOrganization,
    });
    expect(switchOrganization).not.toHaveBeenCalled();
    expect(mocks.success).toHaveBeenCalledWith("Left Acme");
  });

  it("switches from the named page the first time only", async () => {
    const switchOrganization = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockImplementationOnce(shows);
    await switchAwayFrom({
      removed: ACME,
      wasActive: true,
      organizations: [ACME, BETA],
      done: "Left",
      switchOrganization,
      firstFrom: "/settings",
    });
    expect(switchOrganization).toHaveBeenCalledWith("org-2", "/settings");
    const options = mocks.error.mock.calls[0]?.[1] as {
      action: { onClick: () => void };
    };
    options.action.onClick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // A retry may come after the page has changed: from wherever it is.
    expect(switchOrganization).toHaveBeenLastCalledWith("org-2");
  });

  it("does not try again for an org that has since become active", async () => {
    const switchOrganization = vi.fn().mockResolvedValueOnce(false);
    await switchAwayFrom({
      removed: ACME,
      wasActive: true,
      organizations: [ACME, BETA],
      done: "Left",
      switchOrganization,
    });
    // Opened another way meanwhile (the switcher's Open organization).
    mocks.activeOrgId = "org-2";
    const options = mocks.error.mock.calls[0]?.[1] as {
      action: { onClick: () => void };
    };
    options.action.onClick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(switchOrganization).toHaveBeenCalledOnce();
  });
});

describe("reportLinkProblem", () => {
  it("says it in place of the last switch's toast, as long as a failure", async () => {
    // A switch that failed leaves its toast.
    mocks.error.mockReturnValueOnce("toast-failed");
    await runOrgSwitch({
      orgId: "org-2",
      name: "Beta",
      start: () => Promise.resolve(false),
      announce: false,
    });
    mocks.error.mockReturnValueOnce("toast-link");
    reportLinkProblem("notMember");
    expect(mocks.dismiss).toHaveBeenCalledWith("toast-failed");
    expect(mocks.error).toHaveBeenLastCalledWith(
      "You're not a member of that organization.",
      expect.objectContaining({ duration: 12_000, action: undefined })
    );
  });
});

describe("the announcement a load leaves for the open after it", () => {
  // A load the user asked for that finds no org active.
  async function loadFindingNone(): Promise<void> {
    await runOrgLoad(
      () => Promise.resolve({ org: true, list: true }),
      true,
      () => Promise.resolve(true)
    );
  }

  it("is taken once", async () => {
    await loadFindingNone();
    expect(takeOpenAnnouncement()).toBe(true);
    expect(takeOpenAnnouncement()).toBe(false);
  });

  it("goes once an org is active", async () => {
    await loadFindingNone();
    noteActiveOrg("org-1");
    expect(takeOpenAnnouncement()).toBe(false);
  });

  it("is not left by a load where only the list failed", async () => {
    await runOrgLoad(
      () => Promise.resolve({ org: true, list: false }),
      true,
      () => Promise.resolve(true)
    );
    expect(takeOpenAnnouncement()).toBe(false);
  });

  it("goes with a fresh page", async () => {
    await loadFindingNone();
    resetOrgSwitchState();
    expect(takeOpenAnnouncement()).toBe(false);
  });
});
