import { describe, expect, it, vi } from "vitest";

// version-diff pulls in step-registry, which `import "server-only"`. That guard
// throws under vitest (no SSR context), so stub it.
vi.mock("server-only", () => ({}));

import { computeVersionDiff } from "@/lib/workflow/version-diff";

const node = (id: string, label: string, config: object = {}) => ({
  id,
  type: "default",
  position: { x: 0, y: 0 },
  data: { type: "action", label, config },
});

describe("computeVersionDiff", () => {
  it("reports no changes for a position-only (cosmetic) move", () => {
    const before = { nodes: [node("n1", "A")], edges: [] };
    const after = {
      nodes: [{ ...node("n1", "A"), position: { x: 999, y: 42 } }],
      edges: [],
    };
    expect(computeVersionDiff(before, after).hasChanges).toBe(false);
  });

  it("detects an added node with its type", () => {
    const before = { nodes: [node("n1", "A")], edges: [] };
    const after = { nodes: [node("n1", "A"), node("n2", "B")], edges: [] };
    const diff = computeVersionDiff(before, after);
    expect(diff.nodesAdded).toEqual([
      { id: "n2", label: "B", nodeType: "action" },
    ]);
    expect(diff.hasChanges).toBe(true);
  });

  it("captures a renamed node with before/after label", () => {
    const before = { nodes: [node("n1", "Old")], edges: [] };
    const after = { nodes: [node("n1", "New")], edges: [] };
    const changed = computeVersionDiff(before, after).nodesChanged;
    expect(changed).toHaveLength(1);
    expect(changed[0].nodeType).toBe("action");
    expect(changed[0].deltas).toContainEqual({
      field: "name",
      before: "Old",
      after: "New",
    });
  });

  it("lists changed config keys", () => {
    const before = { nodes: [node("n1", "A", { amount: 1 })], edges: [] };
    const after = { nodes: [node("n1", "A", { amount: 2 })], edges: [] };
    const delta = computeVersionDiff(before, after).nodesChanged[0].deltas[0];
    expect(delta.field).toBe("configuration");
    expect(delta.configKeys).toEqual(["amount"]);
  });

  it("names web3 contract arguments by their ABI parameter", () => {
    const abi = JSON.stringify([
      {
        type: "function",
        name: "addPerson",
        inputs: [
          { name: "_name", type: "string" },
          { name: "_favoriteNumber", type: "uint256" },
        ],
        outputs: [],
      },
    ]);
    const cfg = (functionArgs: string) => ({
      actionType: "web3/write-contract",
      abi,
      abiFunction: "addPerson",
      functionArgs,
    });
    const before = {
      nodes: [node("n1", "Write Contract", cfg(JSON.stringify(["", "7"])))],
      edges: [],
    };
    const after = {
      nodes: [node("n1", "Write Contract", cfg(JSON.stringify(["joel", "7"])))],
      edges: [],
    };
    const delta = computeVersionDiff(before, after).nodesChanged[0].deltas.find(
      (d) => d.field === "configuration"
    );
    const change = delta?.configChanges?.find((c) => c.key === "functionArgs");
    expect(change?.before).toBe(
      '{\n  "_name": "",\n  "_favoriteNumber": "7"\n}'
    );
    expect(change?.after).toBe(
      '{\n  "_name": "joel",\n  "_favoriteNumber": "7"\n}'
    );
  });

  it("renders conditionConfig as an ordered rule list", () => {
    const conditionConfig = {
      group: {
        id: "g1",
        logic: "AND",
        rules: [
          {
            id: "r1",
            leftOperand: "{{Manual.triggeredAt}}",
            operator: "==",
            rightOperand: "{{Write Contract.success}}",
          },
          {
            id: "r2",
            leftOperand: "{{Write Contract.success}}",
            operator: "==",
            rightOperand: "{{System.unixTimestamp}}",
          },
        ],
      },
    };
    const cfg = (rightOperand: string) => ({
      actionType: "Condition",
      conditionConfig: JSON.stringify({
        group: {
          ...conditionConfig.group,
          rules: [
            conditionConfig.group.rules[0],
            { ...conditionConfig.group.rules[1], rightOperand },
          ],
        },
      }),
    });
    const before = {
      nodes: [node("n1", "Condition", cfg(""))],
      edges: [],
    };
    const after = {
      nodes: [node("n1", "Condition", cfg("{{System.unixTimestamp}}"))],
      edges: [],
    };
    const delta = computeVersionDiff(before, after).nodesChanged[0].deltas.find(
      (d) => d.field === "configuration"
    );
    const change = delta?.configChanges?.find(
      (c) => c.key === "conditionConfig"
    );
    expect(change?.after).toBe(
      "1. {{Manual.triggeredAt}} == {{Write Contract.success}}\nAND\n2. {{Write Contract.success}} == {{System.unixTimestamp}}"
    );
    // Rule order is preserved and the empty right operand renders as a bare op.
    expect(change?.before).toBe(
      "1. {{Manual.triggeredAt}} == {{Write Contract.success}}\nAND\n2. {{Write Contract.success}} =="
    );
  });

  it("tags connection refs with endpoint node ids", () => {
    const before = {
      nodes: [node("n1", "Trigger"), node("n2", "Send")],
      edges: [],
    };
    const after = {
      nodes: [node("n1", "Trigger"), node("n2", "Send")],
      edges: [{ id: "e1", source: "n1", target: "n2" }],
    };
    expect(computeVersionDiff(before, after).connectionsAdded).toEqual([
      { from: "Trigger", to: "Send", fromId: "n1", toId: "n2" },
    ]);
  });

  it("detects added and removed connections with node labels", () => {
    const before = {
      nodes: [node("n1", "Trigger"), node("n2", "Send")],
      edges: [],
    };
    const after = {
      nodes: [node("n1", "Trigger"), node("n2", "Send")],
      edges: [{ id: "e1", source: "n1", target: "n2" }],
    };
    const diff = computeVersionDiff(before, after);
    expect(diff.connectionsAdded).toEqual([
      { from: "Trigger", to: "Send", fromId: "n1", toId: "n2" },
    ]);
    expect(computeVersionDiff(after, before).connectionsRemoved).toEqual([
      { from: "Trigger", to: "Send", fromId: "n1", toId: "n2" },
    ]);
  });

  it("ignores cosmetic edge styling, tracks reconnection", () => {
    const before = {
      nodes: [node("n1", "A"), node("n2", "B")],
      edges: [{ id: "e1", source: "n1", target: "n2", animated: false }],
    };
    const styled = {
      nodes: [node("n1", "A"), node("n2", "B")],
      edges: [{ id: "e1", source: "n1", target: "n2", animated: true }],
    };
    expect(computeVersionDiff(before, styled).hasChanges).toBe(false);
  });

  it("returns empty diff when there is no previous version", () => {
    const after = { nodes: [node("n1", "A")], edges: [] };
    expect(computeVersionDiff(null, after).hasChanges).toBe(false);
  });
});
