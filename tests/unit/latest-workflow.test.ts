import { describe, expect, it } from "vitest";
import { latestVisibleWorkflow } from "@/lib/workflow/latest-workflow";

function workflow(
  id: string,
  updatedAt: string,
  extra: { name?: string; deletedAt?: string | null } = {}
): { id: string; name: string; updatedAt: string; deletedAt: string | null } {
  return {
    id,
    name: extra.name ?? id,
    updatedAt,
    deletedAt: extra.deletedAt ?? null,
  };
}

describe("latestVisibleWorkflow", () => {
  it("picks the workflow updated last", () => {
    expect(
      latestVisibleWorkflow([
        workflow("old", "2026-10-01T00:00:00Z"),
        workflow("new", "2026-10-03T00:00:00Z"),
        workflow("mid", "2026-10-02T00:00:00Z"),
      ])?.id
    ).toBe("new");
  });

  it("skips the scratch workflow and deleted ones", () => {
    expect(
      latestVisibleWorkflow([
        workflow("scratch", "2026-10-05T00:00:00Z", { name: "__current__" }),
        workflow("gone", "2026-10-04T00:00:00Z", {
          deletedAt: "2026-10-04T00:00:00Z",
        }),
        workflow("kept", "2026-10-01T00:00:00Z"),
      ])?.id
    ).toBe("kept");
  });

  it("returns nothing when no workflow is visible", () => {
    expect(
      latestVisibleWorkflow([
        workflow("scratch", "2026-10-05T00:00:00Z", { name: "__current__" }),
      ])
    ).toBeUndefined();
  });

  it("does not reorder the list it is given", () => {
    const list = [
      workflow("a", "2026-10-01T00:00:00Z"),
      workflow("b", "2026-10-02T00:00:00Z"),
    ];
    latestVisibleWorkflow(list);
    expect(list.map((w) => w.id)).toEqual(["a", "b"]);
  });
});
