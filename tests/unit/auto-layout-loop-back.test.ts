import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { computeAutoLayout } from "@/lib/workflow/editor/auto-layout";

const at = (x: number, y: number): { x: number; y: number } => ({ x, y });

describe("computeAutoLayout with a loop-back edge", () => {
  const nodes = [
    { id: "T", type: "trigger", position: at(0, 0) },
    { id: "A", type: "action", position: at(0, 0) },
    { id: "B", type: "action", position: at(0, 0) },
    { id: "C", type: "action", position: at(0, 0) },
    { id: "D", type: "action", position: at(0, 0) },
  ];
  const edges = [
    { source: "T", target: "A" },
    { source: "A", target: "B" },
    { source: "B", target: "C" },
    { source: "B", target: "D" },
    { source: "D", target: "B" },
  ];

  it("lays the loop out in graph order rather than stacking it as disconnected", () => {
    const positions = computeAutoLayout(nodes, edges);
    const xOf = (id: string): number => positions.get(id)?.x ?? Number.NaN;

    expect(xOf("T")).toBeLessThan(xOf("A"));
    expect(xOf("A")).toBeLessThan(xOf("B"));
    expect(xOf("B")).toBeLessThan(xOf("C"));
    expect(xOf("B")).toBeLessThan(xOf("D"));
  });

  it("places the loop body on the same columns as the plain chain", () => {
    const withLoop = computeAutoLayout(nodes, edges);
    const withoutLoop = computeAutoLayout(
      nodes,
      edges.filter((e) => !(e.source === "D" && e.target === "B"))
    );

    for (const id of ["T", "A", "B", "C", "D"]) {
      expect(withLoop.get(id)?.x).toBe(withoutLoop.get(id)?.x);
    }
  });
});
