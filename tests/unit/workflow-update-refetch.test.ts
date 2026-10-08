import { afterEach, describe, expect, it, vi } from "vitest";

const refetchSidebarIfTriggerChanged = vi.hoisted(() => vi.fn());
vi.mock("@/lib/refetch-sidebar", () => ({ refetchSidebarIfTriggerChanged }));

import { workflowApi } from "@/lib/api-client";

const nodes = [
  {
    id: "t",
    type: "trigger",
    position: { x: 0, y: 0 },
    data: { label: "", type: "trigger", config: { triggerType: "Manual" } },
  },
] as Parameters<typeof workflowApi.update>[1]["nodes"];

function respond(status: number): void {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ id: "wf-1" }), { status })
      )
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  refetchSidebarIfTriggerChanged.mockClear();
});

describe("workflowApi.update", () => {
  it("tells the sidebar about the saved nodes", async () => {
    respond(200);
    await workflowApi.update("wf-1", { nodes, edges: [] });
    expect(refetchSidebarIfTriggerChanged).toHaveBeenCalledWith("wf-1", nodes);
  });

  it("says nothing for a save without nodes", async () => {
    respond(200);
    await workflowApi.update("wf-1", { name: "Renamed" });
    expect(refetchSidebarIfTriggerChanged).not.toHaveBeenCalled();
  });

  it("says nothing when the save fails", async () => {
    respond(500);
    await expect(
      workflowApi.update("wf-1", { nodes, edges: [] })
    ).rejects.toThrow();
    expect(refetchSidebarIfTriggerChanged).not.toHaveBeenCalled();
  });
});
