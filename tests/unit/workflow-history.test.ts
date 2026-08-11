import { beforeEach, describe, expect, it, vi } from "vitest";

// history -> version-diff -> step-registry, which `import "server-only"`. That
// guard throws under vitest (no SSR context), so stub it.
vi.mock("server-only", () => ({}));

const { mockInsertValues, mockLimit, mockInsert, mockSelect } = vi.hoisted(
  () => {
    const limit = vi.fn();
    const insertValues = vi.fn();
    const chain = {
      from: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit,
    };
    return {
      mockInsertValues: insertValues,
      mockLimit: limit,
      mockInsert: vi.fn(() => ({ values: insertValues })),
      mockSelect: vi.fn(() => chain),
    };
  }
);

vi.mock("@/lib/db", () => ({
  db: { select: mockSelect, insert: mockInsert },
}));
vi.mock("@/lib/logging", () => ({
  ErrorCategory: { DATABASE: "database" },
  logSystemError: vi.fn(),
}));

import { recordWorkflowSnapshot } from "@/lib/workflow/history";

const SHA256_HEX = /^[a-f0-9]{64}$/;
const actor = { userId: "u1", organizationId: "o1", authMethod: "session" };
const wf = {
  name: "Flow",
  nodes: [{ id: "n1", type: "trigger", data: { kind: "Webhook" } }],
  edges: [{ id: "e1", source: "n1", target: "n2" }],
  enabled: false,
};

beforeEach(() => {
  mockInsertValues.mockReset();
  mockInsertValues.mockResolvedValue(undefined);
  mockLimit.mockReset();
  mockInsert.mockClear();
});

describe("recordWorkflowSnapshot", () => {
  it("writes version 1 with null change for a create (no prior, no before)", async () => {
    mockLimit.mockResolvedValue([]);

    await recordWorkflowSnapshot({
      workflowId: "wf1",
      before: null,
      after: wf,
      actor,
      source: "create",
    });

    const row = mockInsertValues.mock.calls[0][0];
    expect(row).toMatchObject({
      workflowId: "wf1",
      version: 1,
      changedByUserId: "u1",
      organizationId: "o1",
      source: "create",
      change: null,
      previousVersion: null,
      previousHash: null,
    });
    expect(row.contentHash).toMatch(SHA256_HEX);
    expect(row.snapshot.nodes).toEqual(wf.nodes);
  });

  it("increments version and chains the previous hash on update", async () => {
    mockLimit.mockResolvedValue([{ version: 1, contentHash: "prevhash" }]);

    await recordWorkflowSnapshot({
      workflowId: "wf1",
      before: wf,
      after: { ...wf, name: "Renamed" },
      actor,
      source: "update",
    });

    const row = mockInsertValues.mock.calls[0][0];
    expect(row.version).toBe(2);
    expect(row.previousVersion).toBe(1);
    expect(row.previousHash).toBe("prevhash");
    // The name change is captured as a settings diff on the stored VersionDiff.
    expect(row.change.hasChanges).toBe(true);
    expect(row.change.settings).toContainEqual(
      expect.objectContaining({
        field: "name",
        before: "Flow",
        after: "Renamed",
      })
    );
  });

  it("does not record a version for a cosmetic-only change", async () => {
    mockLimit.mockResolvedValue([{ version: 1, contentHash: "prevhash" }]);
    const moved = {
      ...wf,
      nodes: [{ ...wf.nodes[0], position: { x: 500, y: 12 }, selected: true }],
    };

    await recordWorkflowSnapshot({
      workflowId: "wf1",
      before: wf,
      after: moved,
      actor,
      source: "update",
    });

    // An empty diff is a no-op version: it is skipped, so nothing is inserted.
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it("never throws when the insert fails", async () => {
    mockLimit.mockResolvedValue([]);
    mockInsertValues.mockRejectedValue(new Error("db down"));
    await expect(
      recordWorkflowSnapshot({
        workflowId: "wf1",
        before: null,
        after: wf,
        actor,
        source: "create",
      })
    ).resolves.toBeUndefined();
  });
});
