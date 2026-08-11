import { beforeEach, describe, expect, it, vi } from "vitest";

// KEEP-440: workflows are soft-deleted (deletedAt set) instead of hard-deleted
// so the listed slug stays bound to the row and cannot be re-claimed. These
// tests cover the unit-level surface of that change: the soft-delete helpers
// and the isDeleted signal getWorkflowAccess now exposes. The end-to-end
// "deleted slug cannot be re-claimed" property is exercised against the dev
// server via the kh CLI.

const { mockMemberLimit } = vi.hoisted(() => ({
  mockMemberLimit: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: mockMemberLimit,
          })),
        })),
        where: vi.fn(() => ({
          limit: mockMemberLimit,
        })),
      })),
    })),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  member: {
    id: "id",
    organizationId: "organizationId",
    userId: "userId",
  },
  users: {
    id: "id",
    deactivatedAt: "deactivated_at",
  },
  workflows: {
    deletedAt: "deleted_at",
  },
}));

import { getWorkflowAccess } from "@/lib/workflow/access";
import {
  filterPickerVisible,
  isWorkflowDeleted,
  workflowNotDeleted,
} from "@/lib/workflow/soft-delete";

const ANON_WORKFLOW = {
  id: "wf-anon",
  userId: "creator",
  organizationId: null,
  isAnonymous: true,
};

const ORG_WORKFLOW = {
  id: "wf-org",
  userId: "creator",
  organizationId: "org-1",
  isAnonymous: false,
};

describe("isWorkflowDeleted", () => {
  it("returns true when deletedAt is set", () => {
    expect(isWorkflowDeleted({ deletedAt: new Date() })).toBe(true);
  });

  it("returns false when deletedAt is null", () => {
    expect(isWorkflowDeleted({ deletedAt: null })).toBe(false);
  });
});

describe("workflowNotDeleted", () => {
  it("returns a SQL predicate", () => {
    expect(workflowNotDeleted()).toBeDefined();
  });

  it("returns a fresh predicate instance per call (no shared mutable state)", () => {
    expect(workflowNotDeleted()).not.toBe(workflowNotDeleted());
  });
});

describe("getWorkflowAccess soft-delete signal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("flags isDeleted when the workflow row has a deletedAt timestamp", async () => {
    // A same-org member retains full access -- isDeleted is an orthogonal
    // signal so owner-facing read paths can keep serving the row with a
    // marker. Access is org-based now, so the subject must be acting in the
    // workflow's org and be a current member of it.
    mockMemberLimit.mockResolvedValue([{ id: "member-1" }]);

    const access = await getWorkflowAccess(
      { ...ORG_WORKFLOW, deletedAt: new Date() },
      { userId: "member-user", organizationId: "org-1" }
    );

    expect(access.isDeleted).toBe(true);
    expect(access.hasFullAccess).toBe(true);
  });

  it("does not flag isDeleted when deletedAt is null", async () => {
    const access = await getWorkflowAccess(
      { ...ANON_WORKFLOW, deletedAt: null },
      { userId: "creator", organizationId: null }
    );

    expect(access.isDeleted).toBe(false);
  });

  it("does not flag isDeleted when deletedAt is absent (trimmed workflow shape)", async () => {
    const access = await getWorkflowAccess(ANON_WORKFLOW, {
      userId: "creator",
      organizationId: null,
    });

    expect(access.isDeleted).toBe(false);
  });
});

describe("filterPickerVisible", () => {
  type PickerRow = {
    id: string;
    name: string;
    deletedAt?: Date | string | null;
    enabled?: boolean;
  };

  it("excludes soft-deleted rows (deletedAt set)", () => {
    const rows: PickerRow[] = [
      { id: "a", name: "Alpha", deletedAt: null },
      { id: "b", name: "Beta", deletedAt: new Date() },
      { id: "c", name: "Gamma", deletedAt: "2026-05-29T00:00:00.000Z" },
    ];

    expect(filterPickerVisible(rows).map((row) => row.id)).toEqual(["a"]);
  });

  it("excludes the internal __current__ stub", () => {
    const rows: PickerRow[] = [
      { id: "current", name: "__current__", deletedAt: null },
      { id: "a", name: "Alpha", deletedAt: null },
    ];

    expect(filterPickerVisible(rows).map((row) => row.id)).toEqual(["a"]);
  });

  it("keeps disabled rows visible (enabled: false)", () => {
    const rows: PickerRow[] = [
      { id: "a", name: "Alpha", deletedAt: null, enabled: true },
      { id: "b", name: "Beta", deletedAt: null, enabled: false },
    ];

    expect(filterPickerVisible(rows).map((row) => row.id)).toEqual(["a", "b"]);
  });

  it("treats missing deletedAt the same as null", () => {
    const rows: PickerRow[] = [
      { id: "a", name: "Alpha" },
      { id: "b", name: "Beta", deletedAt: null },
    ];

    expect(filterPickerVisible(rows).map((row) => row.id)).toEqual(["a", "b"]);
  });

  it("preserves input order", () => {
    const rows: PickerRow[] = [
      { id: "c", name: "Gamma", deletedAt: null },
      { id: "a", name: "Alpha", deletedAt: null },
      { id: "b", name: "Beta", deletedAt: null },
    ];

    expect(filterPickerVisible(rows).map((row) => row.id)).toEqual([
      "c",
      "a",
      "b",
    ]);
  });
});
