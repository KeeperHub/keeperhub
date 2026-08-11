import { describe, expect, it, vi } from "vitest";

// The SQL builder references workflows/organization columns; the in-memory
// predicate is pure. Mock the schema so importing the module under test does
// not pull a real db connection (executable.ts only needs the column handles
// for the SQL builder, which these tests assert returns a defined predicate).
vi.mock("@/lib/db/schema", () => ({
  workflows: {
    enabled: "enabled",
    deletedAt: "deleted_at",
    deactivatedAt: "deactivated_at",
    organizationId: "organization_id",
    userId: "user_id",
  },
  organization: { id: "id", deactivatedAt: "deactivated_at" },
}));

import {
  getWorkflowExecutability,
  workflowExecutableConditions,
  workflowReachableConditions,
} from "@/lib/workflow/executable";

describe("getWorkflowExecutability", () => {
  it("is executable when enabled, not deleted, not deactivated, org active", () => {
    expect(
      getWorkflowExecutability({
        enabled: true,
        deletedAt: null,
        deactivatedAt: null,
        orgDeactivatedAt: null,
      })
    ).toEqual({ executable: true });
  });

  it("reports 'deleted' when soft-deleted, even if still enabled", () => {
    expect(
      getWorkflowExecutability({
        enabled: true,
        deletedAt: new Date(),
      })
    ).toEqual({ executable: false, reason: "deleted" });
  });

  it("prefers 'deleted' over 'disabled' when both apply", () => {
    expect(
      getWorkflowExecutability({
        enabled: false,
        deletedAt: new Date(),
      })
    ).toEqual({ executable: false, reason: "deleted" });
  });

  it("reports 'deactivated' when the workflow is deactivated, even if still enabled", () => {
    expect(
      getWorkflowExecutability({
        enabled: true,
        deletedAt: null,
        deactivatedAt: new Date(),
      })
    ).toEqual({ executable: false, reason: "deactivated" });
  });

  it("prefers 'deactivated' over 'disabled' so a disabled+deactivated workflow stays blocked from manual runs", () => {
    expect(
      getWorkflowExecutability({
        enabled: false,
        deletedAt: null,
        deactivatedAt: new Date(),
      })
    ).toEqual({ executable: false, reason: "deactivated" });
  });

  it("prefers 'deleted' over 'deactivated' when both apply", () => {
    expect(
      getWorkflowExecutability({
        enabled: true,
        deletedAt: new Date(),
        deactivatedAt: new Date(),
      })
    ).toEqual({ executable: false, reason: "deleted" });
  });

  it("reports 'org_deactivated' when the owning org is deactivated (owner gate)", () => {
    expect(
      getWorkflowExecutability({
        enabled: true,
        deletedAt: null,
        orgDeactivatedAt: new Date(),
      })
    ).toEqual({ executable: false, reason: "org_deactivated" });
  });

  it("prefers 'deactivated' (workflow) over 'org_deactivated' when both apply", () => {
    expect(
      getWorkflowExecutability({
        enabled: true,
        deactivatedAt: new Date(),
        orgDeactivatedAt: new Date(),
      })
    ).toEqual({ executable: false, reason: "deactivated" });
  });

  it("prefers 'org_deactivated' over 'disabled' so a disabled workflow in a dead org stays blocked", () => {
    expect(
      getWorkflowExecutability({
        enabled: false,
        orgDeactivatedAt: new Date(),
      })
    ).toEqual({ executable: false, reason: "org_deactivated" });
  });

  it("reports 'disabled' when not enabled and otherwise live", () => {
    expect(
      getWorkflowExecutability({
        enabled: false,
        deletedAt: null,
        deactivatedAt: null,
        orgDeactivatedAt: null,
      })
    ).toEqual({ executable: false, reason: "disabled" });
  });

  it("treats absent timestamps as not-set (trimmed shapes)", () => {
    expect(getWorkflowExecutability({ enabled: true })).toEqual({
      executable: true,
    });
  });
});

describe("workflowExecutableConditions", () => {
  it("returns a defined SQL predicate", () => {
    expect(workflowExecutableConditions()).toBeDefined();
  });

  it("returns a fresh predicate instance per call (no shared mutable state)", () => {
    expect(workflowExecutableConditions()).not.toBe(
      workflowExecutableConditions()
    );
  });
});

describe("workflowReachableConditions", () => {
  it("returns a defined SQL predicate", () => {
    expect(workflowReachableConditions()).toBeDefined();
  });

  it("returns a fresh predicate instance per call (no shared mutable state)", () => {
    expect(workflowReachableConditions()).not.toBe(
      workflowReachableConditions()
    );
  });
});
