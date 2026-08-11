import { describe, expect, it } from "vitest";
import { hashWorkflowDefinition } from "@/lib/workflow/content-hash";

const SHA256_HEX = /^[a-f0-9]{64}$/;
const nodes = [{ id: "n1", type: "trigger", data: { kind: "Webhook" } }];
const edges = [{ id: "e1", source: "n1", target: "n2" }];

describe("hashWorkflowDefinition", () => {
  it("is a stable 64-char hex sha256", () => {
    const hash = hashWorkflowDefinition(nodes, edges);
    expect(hash).toMatch(SHA256_HEX);
    // Deterministic across calls.
    expect(hashWorkflowDefinition(nodes, edges)).toBe(hash);
  });

  it("is independent of object key ordering", () => {
    const reordered = [
      { data: { kind: "Webhook" }, type: "trigger", id: "n1" },
    ];
    expect(hashWorkflowDefinition(reordered, edges)).toBe(
      hashWorkflowDefinition(nodes, edges)
    );
  });

  it("changes when a node value changes", () => {
    const edited = [{ id: "n1", type: "trigger", data: { kind: "Schedule" } }];
    expect(hashWorkflowDefinition(edited, edges)).not.toBe(
      hashWorkflowDefinition(nodes, edges)
    );
  });

  it("reproduces the same hash after a revert to an identical definition", () => {
    const original = hashWorkflowDefinition(nodes, edges);
    const changed = hashWorkflowDefinition(
      [{ id: "n1", type: "trigger", data: { kind: "Schedule" } }],
      edges
    );
    const reverted = hashWorkflowDefinition(
      [{ id: "n1", type: "trigger", data: { kind: "Webhook" } }],
      edges
    );
    expect(changed).not.toBe(original);
    expect(reverted).toBe(original);
  });

  it("distinguishes edge changes from node changes", () => {
    const otherEdges = [{ id: "e1", source: "n1", target: "n3" }];
    expect(hashWorkflowDefinition(nodes, otherEdges)).not.toBe(
      hashWorkflowDefinition(nodes, edges)
    );
  });

  it("ignores cosmetic node fields (position, selection, size)", () => {
    const moved = [
      {
        id: "n1",
        type: "trigger",
        data: { kind: "Webhook" },
        position: { x: 999, y: 42 },
        selected: true,
        width: 240,
        height: 80,
      },
    ];
    expect(hashWorkflowDefinition(moved, edges)).toBe(
      hashWorkflowDefinition(nodes, edges)
    );
  });

  it("ignores cosmetic edge styling but still tracks connectivity", () => {
    const styledSameConn = [
      { id: "e1", source: "n1", target: "n2", animated: true, style: { x: 1 } },
    ];
    expect(hashWorkflowDefinition(nodes, styledSameConn)).toBe(
      hashWorkflowDefinition(nodes, edges)
    );
    const rewired = [{ id: "e1", source: "n1", target: "n9" }];
    expect(hashWorkflowDefinition(nodes, rewired)).not.toBe(
      hashWorkflowDefinition(nodes, edges)
    );
  });
});
