import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/refetch-sidebar", () => ({
  refetchSidebarIfTriggerChanged: vi.fn(),
}));

import { workflowApi } from "@/lib/api-client";
import type { WorkflowNode } from "@/lib/workflow/store";

// The server refuses a new Web3 Connection on a step that ignores it, so the
// editor must never send the stale key it may still hold in memory.

const fetchMock = vi.fn();

function node(
  id: string,
  config: Record<string, unknown>,
  type = "action"
): WorkflowNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    data: { label: id, type, config },
  } as WorkflowNode;
}

const NODES = [
  node("trigger", { triggerType: "Manual" }, "trigger"),
  node("aave", { actionType: "aave-v3/supply", web3Connection: "eoa" }),
  node("write", { actionType: "web3/write-contract", web3Connection: "eoa" }),
];

function sentConfigs(): Record<string, Record<string, unknown>> {
  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  const body = JSON.parse(String(init.body)) as {
    nodes: { id: string; data: { config: Record<string, unknown> } }[];
  };
  return Object.fromEntries(body.nodes.map((n) => [n.id, n.data.config]));
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(
    Response.json({ id: "wf-1", nodes: [], edges: [] })
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("editor saves drop an ignored Web3 Connection", () => {
  const saves: [string, () => Promise<unknown>][] = [
    ["PATCH", () => workflowApi.update("wf-1", { nodes: NODES, edges: [] })],
    [
      "create",
      () => workflowApi.create({ name: "wf", nodes: NODES, edges: [] }),
    ],
    ["/current", () => workflowApi.saveCurrent(NODES, [])],
  ];

  it.each(saves)("%s", async (_name, save) => {
    await save();
    const configs = sentConfigs();
    expect(configs.aave).toEqual({ actionType: "aave-v3/supply" });
    expect(configs.write).toEqual({
      actionType: "web3/write-contract",
      web3Connection: "eoa",
    });
    expect(configs.trigger).toEqual({ triggerType: "Manual" });
    // The editor's own nodes are left as they are.
    expect(NODES[1].data.config?.web3Connection).toBe("eoa");
  });

  it("sends a PATCH without nodes unchanged", async () => {
    await workflowApi.update("wf-1", { name: "renamed" });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ name: "renamed" });
  });
});
