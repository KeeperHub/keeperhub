/**
 * The durability layer assigns step identity by invocation order: the Nth
 * `useStep` call in a run gets the Nth id, with no name or content matching. A
 * replay must therefore invoke steps in exactly the order the event log
 * recorded, or every id past the divergence point refers to the wrong step.
 *
 * `executeActionStep` used to `await importer()` right before calling the step,
 * which put the invocation into a racing microtask -- real module I/O on the
 * first pass, a resolved cache hit on replay. With N branches fanned out in
 * parallel that reorders the step calls between passes.
 *
 * Preloading every reachable step module up front removes that await, so the
 * fan-out path is synchronous from executeNode through to the step call.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const importOrder: string[] = [];

function makeImporter(actionType: string, fnName: string) {
  return {
    importer: async () => {
      importOrder.push(actionType);
      await Promise.resolve();
      return { [fnName]: vi.fn() };
    },
    stepFunction: fnName,
  };
}

vi.mock("@/lib/step-registry", () => ({
  getStepImporter: (actionType: string) => {
    if (actionType === "web3/read-contract") {
      return makeImporter(actionType, "readContractStep");
    }
    if (actionType === "web3/query-events") {
      return makeImporter(actionType, "queryEventsStep");
    }
    if (actionType === "discord/send-message") {
      return makeImporter(actionType, "sendMessageStep");
    }
    return;
  },
}));

vi.mock("@/plugins/legacy-mappings", () => ({
  LEGACY_ACTION_MAPPINGS: { "web3/old-read": "web3/read-contract" },
}));

const { preloadStepFunctions } = await import(
  "@/lib/workflow/executor/executor.workflow"
);
type WorkflowNode = Parameters<typeof preloadStepFunctions>[0][number];

type TestNode = {
  id: string;
  data: {
    type: string;
    label?: string;
    config?: { actionType?: string };
  };
};

function actionNode(id: string, actionType: string): TestNode {
  return { id, data: { type: "action", config: { actionType } } };
}

// WorkflowNode carries position/measured fields this unit never reads.
const asNodes = (nodes: TestNode[]): WorkflowNode[] =>
  nodes as unknown as WorkflowNode[];

describe("preloadStepFunctions", () => {
  beforeEach(() => {
    importOrder.length = 0;
  });

  it("resolves a step function for every action type in the graph", async () => {
    const table = await preloadStepFunctions(
      asNodes([
        { id: "trigger", data: { type: "trigger" } },
        actionNode("r1", "web3/read-contract"),
        actionNode("r2", "web3/read-contract"),
        actionNode("alert", "discord/send-message"),
      ])
    );

    expect(typeof table.get("web3/read-contract")).toBe("function");
    expect(typeof table.get("discord/send-message")).toBe("function");
  });

  it("imports each distinct action type once, however many nodes use it", async () => {
    await preloadStepFunctions(
      asNodes(
        Array.from({ length: 14 }, (_, i) =>
          actionNode(`read-${i}`, "web3/query-events")
        )
      )
    );

    expect(importOrder).toEqual(["web3/query-events"]);
  });

  it("resolves in a stable order regardless of node order", async () => {
    const forward = asNodes([
      actionNode("a", "web3/read-contract"),
      actionNode("b", "discord/send-message"),
      actionNode("c", "web3/query-events"),
    ]);
    await preloadStepFunctions(forward);
    const firstPass = [...importOrder];

    importOrder.length = 0;
    await preloadStepFunctions(asNodes([...forward].reverse()));

    expect(importOrder).toEqual(firstPass);
  });

  it("follows legacy action renames", async () => {
    const table = await preloadStepFunctions(
      asNodes([actionNode("legacy", "web3/old-read")])
    );

    expect(typeof table.get("web3/old-read")).toBe("function");
  });

  it("skips an unknown action type without throwing", async () => {
    const table = await preloadStepFunctions(
      asNodes([
        actionNode("good", "web3/read-contract"),
        actionNode("bogus", "not-a-real/action"),
      ])
    );

    expect(table.has("not-a-real/action")).toBe(false);
    expect(typeof table.get("web3/read-contract")).toBe("function");
  });

  it("covers For Each body nodes, which are not reached by graph traversal", async () => {
    const table = await preloadStepFunctions(
      asNodes([
        actionNode("loop", "For Each"),
        actionNode("body", "web3/read-contract"),
      ])
    );

    expect(typeof table.get("web3/read-contract")).toBe("function");
  });

  it("leaves no import pending, so later step calls need no await to dispatch", async () => {
    const nodes = asNodes([
      actionNode("r1", "web3/read-contract"),
      actionNode("q1", "web3/query-events"),
    ]);

    const table = await preloadStepFunctions(nodes);
    importOrder.length = 0;

    // Dispatch is a synchronous Map read; nothing re-enters the importer.
    for (const actionType of ["web3/read-contract", "web3/query-events"]) {
      expect(table.get(actionType)).toBeDefined();
    }
    expect(importOrder).toEqual([]);
  });
});
