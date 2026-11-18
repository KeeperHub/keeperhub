// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  member: { role: undefined as string | undefined, isLoading: false },
}));

vi.mock("@/lib/hooks/use-organization", () => ({
  useActiveMember: () => mocks.member,
}));

import { type OrgAccess, useOrgAccess } from "@/lib/hooks/use-org-access";
import { canEditOrg, isViewerRole } from "@/lib/organization/role-label";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  mocks.member = { role: undefined, isLoading: false };
});

function readAccess(
  role: string | undefined,
  isLoading = false
): OrgAccess | null {
  mocks.member = { role, isLoading };
  let access: OrgAccess | null = null;
  function Probe(): null {
    access = useOrgAccess();
    return null;
  }
  act(() => {
    root.render(<Probe />);
  });
  return access;
}

describe("canEditOrg", () => {
  it.each(["owner", "admin", "member"])("lets %s edit", (role) => {
    expect(canEditOrg(role)).toBe(true);
  });

  it("refuses a viewer, in any casing", () => {
    expect(canEditOrg("viewer")).toBe(false);
    expect(canEditOrg("Viewer")).toBe(false);
  });

  it("refuses an unknown or missing role", () => {
    expect(canEditOrg(undefined)).toBe(false);
    expect(canEditOrg(null)).toBe(false);
    expect(canEditOrg("")).toBe(false);
  });

  it("only calls a viewer a viewer", () => {
    expect(isViewerRole("viewer")).toBe(true);
    expect(isViewerRole("member")).toBe(false);
    expect(isViewerRole(undefined)).toBe(false);
  });
});

describe("useOrgAccess", () => {
  it.each(["owner", "admin", "member"])("lets %s edit", (role) => {
    expect(readAccess(role)).toEqual({
      role,
      isLoading: false,
      isViewer: false,
      canEdit: true,
    });
  });

  it("marks a viewer read-only", () => {
    expect(readAccess("viewer")).toEqual({
      role: "viewer",
      isLoading: false,
      isViewer: true,
      canEdit: false,
    });
  });

  it("allows no edits while the role loads, without calling it a viewer", () => {
    expect(readAccess(undefined, true)).toEqual({
      role: undefined,
      isLoading: true,
      isViewer: false,
      canEdit: false,
    });
  });

  it("allows no edits without a membership, without calling it a viewer", () => {
    const access = readAccess(undefined);
    expect(access?.canEdit).toBe(false);
    expect(access?.isViewer).toBe(false);
  });
});
