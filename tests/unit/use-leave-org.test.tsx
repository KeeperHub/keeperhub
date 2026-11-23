// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  leave: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
  refetch: vi.fn(),
  switchOrganization: vi.fn(),
  deleteOrg: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  refetchOrganizations: vi.fn(),
  // The active organization, as the page has it.
  active: { id: "org-1", name: "Acme" } as { id: string; name: string } | null,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace, refresh: mocks.refresh }),
}));
vi.mock("sonner", () => ({
  toast: {
    success: mocks.success,
    error: mocks.error,
    dismiss: vi.fn(),
    loading: vi.fn(),
  },
}));
vi.mock("@/lib/refetch-organizations", () => ({
  refetchOrganizations: mocks.refetchOrganizations,
}));
vi.mock("@/lib/api-client", () => ({
  ApiError: class extends Error {},
  api: { organization: { leave: mocks.leave } },
}));
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    organization: { delete: mocks.deleteOrg },
    $store: {
      atoms: {
        activeOrganization: { get: () => ({ data: mocks.active }) },
      },
    },
  },
  useSession: () => ({ data: { user: { id: "me" } } }),
}));
// A switch that took, as the app's resolves: once its org is the one shown.
async function switchShowing(
  orgId: string,
  fromPath?: string
): Promise<boolean> {
  const switched = await mocks.switchOrganization(orgId, fromPath);
  if (switched) {
    mocks.active = { id: orgId, name: "" };
  }
  return switched;
}

vi.mock("@/lib/hooks/use-organization", () => ({
  currentActiveOrgId: () => mocks.active?.id,
  useOrganization: () => ({
    switchOrganization: switchShowing,
  }),
  useOrganizations: () => ({
    organizations: [
      { id: "org-1", name: "Acme" },
      { id: "org-2", name: "Beta" },
    ],
    refetch: mocks.refetch,
  }),
}));

import { resetOrgSwitchState } from "@/components/organization/org-switch-runner";
import {
  type LeaveOrgState,
  useLeaveOrg,
} from "@/components/settings/hub/hooks/use-leave-org";

let container: HTMLDivElement;
let root: Root;
let state: LeaveOrgState | null = null;

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function Probe(): null {
  state = useLeaveOrg("org-1", "Acme", false, []);
  return null;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetOrgSwitchState();
  mocks.active = { id: "org-1", name: "Acme" };
  mocks.leave.mockResolvedValue({});
  mocks.refetch.mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<Probe />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("useLeaveOrg", () => {
  it("leaves, opens another organization from /settings and says which", async () => {
    mocks.switchOrganization.mockResolvedValue(true);
    await act(async () => {
      await state?.leave();
    });
    expect(mocks.replace).toHaveBeenCalledWith("/settings");
    expect(mocks.switchOrganization).toHaveBeenCalledWith("org-2", "/settings");
    expect(mocks.success).toHaveBeenCalledWith("Left Acme. Now in Beta.");
  });

  it("says what to do when the other organization cannot be opened", async () => {
    mocks.switchOrganization.mockResolvedValue(false);
    await act(async () => {
      await state?.leave();
    });
    expect(mocks.error).toHaveBeenCalledWith(
      "Left Acme, but couldn't open Beta.",
      expect.objectContaining({ duration: 12_000 })
    );
    expect(mocks.success).not.toHaveBeenCalled();
    // Leaving cleared the session's org, which the page has not heard: it
    // reloads it, so the switchers offer Beta.
    expect(mocks.refetchOrganizations).toHaveBeenCalledOnce();
  });

  it("only says so when the org left was not the one in use", async () => {
    // The active org changed since the page last rendered (the settings
    // page's switch to its org failed, say): as it is when leaving counts.
    mocks.active = { id: "org-2", name: "Beta" };
    await act(async () => {
      await state?.leave();
    });
    expect(mocks.switchOrganization).not.toHaveBeenCalled();
    expect(mocks.success).toHaveBeenCalledWith("Left Acme");
  });

  it("switches away after a delete that has already cleared the active org", async () => {
    // The auth client reloads the active org on the delete, maybe before the
    // hook gets to read it: it reads it before deleting.
    mocks.deleteOrg.mockImplementation(async () => {
      mocks.active = null;
      return { error: null };
    });
    mocks.switchOrganization.mockResolvedValue(true);
    await act(async () => {
      await state?.remove();
    });
    expect(mocks.switchOrganization).toHaveBeenCalledWith("org-2", "/settings");
    expect(mocks.success).toHaveBeenCalledWith("Deleted Acme. Now in Beta.");
  });

  it("deletes, then says which organization is open", async () => {
    mocks.deleteOrg.mockResolvedValue({ error: null });
    mocks.switchOrganization.mockResolvedValue(true);
    await act(async () => {
      await state?.remove();
    });
    expect(mocks.deleteOrg).toHaveBeenCalledWith({ organizationId: "org-1" });
    expect(mocks.success).toHaveBeenCalledWith("Deleted Acme. Now in Beta.");
  });
});
