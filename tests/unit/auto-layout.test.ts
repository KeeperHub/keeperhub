import { describe, expect, it } from "vitest";
import { computeAutoLayout } from "@/lib/workflow/editor/auto-layout";

type TestNode = {
  id: string;
  type?: string;
  position: { x: number; y: number };
};
type TestEdge = {
  source: string;
  target: string;
  sourceHandle?: string | null;
};

const NODE_HEIGHT = 192;
const COLUMN_STEP = 252;

function graph(
  ids: string[],
  links: [string, string, string?][]
): { nodes: TestNode[]; edges: TestEdge[] } {
  return {
    nodes: ids.map((id, index) => ({
      id,
      type: index === 0 ? "trigger" : "action",
      position: { x: 0, y: 0 },
    })),
    edges: links.map(([source, target, sourceHandle]) => ({
      source,
      target,
      sourceHandle: sourceHandle ?? null,
    })),
  };
}

function overlaps(positions: Map<string, { x: number; y: number }>): string[] {
  const byColumn = new Map<number, { id: string; y: number }[]>();
  for (const [id, position] of positions) {
    const column = Math.round(position.x / COLUMN_STEP);
    const list = byColumn.get(column) ?? [];
    list.push({ id, y: position.y });
    byColumn.set(column, list);
  }

  const found: string[] = [];
  for (const list of byColumn.values()) {
    list.sort((a, b) => a.y - b.y);
    for (let i = 1; i < list.length; i++) {
      if (list[i].y - list[i - 1].y < NODE_HEIGHT) {
        found.push(`${list[i - 1].id}/${list[i].id}`);
      }
    }
  }
  return found;
}

function columnOf(
  positions: Map<string, { x: number; y: number }>,
  id: string
): number {
  return Math.round((positions.get(id)?.x ?? 0) / COLUMN_STEP);
}

function rowOf(
  positions: Map<string, { x: number; y: number }>,
  id: string
): number {
  return positions.get(id)?.y ?? 0;
}

/** Pairs of edges whose endpoints swap vertical order while their spans overlap. */
function crossings(
  positions: Map<string, { x: number; y: number }>,
  edges: TestEdge[]
): string[] {
  const found: string[] = [];
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const a = edges[i];
      const b = edges[j];
      const as = positions.get(a.source);
      const at = positions.get(a.target);
      const bs = positions.get(b.source);
      const bt = positions.get(b.target);
      if (!(as && at && bs && bt)) {
        continue;
      }
      const overlap =
        Math.min(at.x, bt.x) > Math.max(as.x, bs.x) ||
        (as.x === bs.x && at.x === bt.x);
      if (!overlap) {
        continue;
      }
      if ((as.y - bs.y) * (at.y - bt.y) < 0) {
        found.push(`${a.source}->${a.target} x ${b.source}->${b.target}`);
      }
    }
  }
  return found;
}

function rowsOf(
  positions: Map<string, { x: number; y: number }>,
  ids: string[]
): number[] {
  return ids.map((id) => positions.get(id)?.y ?? 0);
}

describe("computeAutoLayout", () => {
  it("keeps a loop body clear of the branch that runs beside it", () => {
    const { nodes, edges } = graph(
      [
        "trigger",
        "chainlog",
        "hole",
        "dirt",
        "buildGlobal",
        "pushGlobal",
        "registry",
        "buildList",
        "loop",
        "clipper",
        "liquidatable",
        "chop",
        "price",
        "buildMetrics",
        "pushMetrics",
        "collect",
      ],
      [
        ["trigger", "chainlog"],
        ["chainlog", "hole"],
        ["hole", "dirt"],
        ["dirt", "buildGlobal"],
        ["buildGlobal", "pushGlobal"],
        ["chainlog", "registry"],
        ["registry", "buildList"],
        ["buildList", "loop"],
        ["loop", "clipper", "loop"],
        ["clipper", "liquidatable"],
        ["liquidatable", "chop", "true"],
        ["chop", "price"],
        ["price", "buildMetrics"],
        ["buildMetrics", "pushMetrics"],
        ["pushMetrics", "collect"],
        ["liquidatable", "collect", "false"],
        ["loop", "collect", "done"],
      ]
    );

    const positions = computeAutoLayout(nodes, edges);

    expect(overlaps(positions)).toEqual([]);
    expect(columnOf(positions, "clipper")).toBeGreaterThan(
      columnOf(positions, "loop")
    );
    expect(columnOf(positions, "collect")).toBeGreaterThan(
      columnOf(positions, "pushMetrics")
    );
  });

  it("gives every column at least one node height of clearance", () => {
    const { nodes, edges } = graph(
      ["trigger", "fan", "a", "b", "c", "d", "join"],
      [
        ["trigger", "fan"],
        ["fan", "a"],
        ["fan", "b"],
        ["fan", "c"],
        ["fan", "d"],
        ["a", "join"],
        ["b", "join"],
        ["c", "join"],
        ["d", "join"],
      ]
    );

    const positions = computeAutoLayout(nodes, edges);

    expect(overlaps(positions)).toEqual([]);
  });

  it("keeps a linear chain on one row, one column per step", () => {
    const { nodes, edges } = graph(
      ["trigger", "a", "b", "c"],
      [
        ["trigger", "a"],
        ["a", "b"],
        ["b", "c"],
      ]
    );

    const positions = computeAutoLayout(nodes, edges);

    for (const id of ["a", "b", "c"]) {
      expect(rowOf(positions, id)).toBe(rowOf(positions, "trigger"));
    }
    expect(columnOf(positions, "c")).toBe(3);
  });

  it("puts the true branch above the false branch, centred on the condition", () => {
    const { nodes, edges } = graph(
      ["trigger", "condition", "yes", "no"],
      [
        ["trigger", "condition"],
        ["condition", "yes", "true"],
        ["condition", "no", "false"],
      ]
    );

    const positions = computeAutoLayout(nodes, edges);

    expect(rowOf(positions, "yes")).toBeLessThan(rowOf(positions, "no"));
    const middle = (rowOf(positions, "yes") + rowOf(positions, "no")) / 2;
    expect(Math.abs(middle - rowOf(positions, "condition"))).toBeLessThan(1);
  });

  it("puts the done branch above the loop body, the way the handles sit", () => {
    const { nodes, edges } = graph(
      ["trigger", "each", "body", "collect"],
      [
        ["trigger", "each"],
        ["each", "body", "loop"],
        ["each", "collect", "done"],
      ]
    );

    const positions = computeAutoLayout(nodes, edges);

    expect(rowOf(positions, "collect")).toBeLessThan(rowOf(positions, "body"));
    const middle = (rowOf(positions, "collect") + rowOf(positions, "body")) / 2;
    expect(Math.abs(middle - rowOf(positions, "each"))).toBeLessThan(1);
  });

  it("keeps a lone branch on its parent's row whichever handle it leaves from", () => {
    for (const handle of ["true", "false", "loop", "done"]) {
      const { nodes, edges } = graph(
        ["trigger", "branch", "only"],
        [
          ["trigger", "branch"],
          ["branch", "only", handle],
        ]
      );

      const positions = computeAutoLayout(nodes, edges);

      expect(rowOf(positions, "only")).toBe(rowOf(positions, "branch"));
    }
  });

  it("gives each branch its own band of rows", () => {
    const { nodes, edges } = graph(
      ["trigger", "split", "up1", "up2", "up3", "down1", "down2", "down3"],
      [
        ["trigger", "split"],
        ["split", "up1", "true"],
        ["up1", "up2"],
        ["up2", "up3"],
        ["split", "down1", "false"],
        ["down1", "down2"],
        ["down2", "down3"],
      ]
    );

    const positions = computeAutoLayout(nodes, edges);

    const upper = rowsOf(positions, ["up1", "up2", "up3"]);
    const lower = rowsOf(positions, ["down1", "down2", "down3"]);
    expect(Math.max(...upper)).toBeLessThan(Math.min(...lower));
    expect(crossings(positions, edges)).toEqual([]);
  });

  it("does not run a branching node's rows through a neighbouring branch", () => {
    const { nodes, edges } = graph(
      [
        "trigger",
        "split",
        "first",
        "firstYes",
        "firstNo",
        "second",
        "secondOnly",
        "third",
        "thirdYes",
        "thirdNo",
      ],
      [
        ["trigger", "split"],
        ["split", "first", "true"],
        ["first", "firstYes", "true"],
        ["first", "firstNo", "false"],
        ["split", "second"],
        ["second", "secondOnly", "true"],
        ["split", "third", "false"],
        ["third", "thirdYes", "true"],
        ["third", "thirdNo", "false"],
      ]
    );

    const positions = computeAutoLayout(nodes, edges);

    expect(crossings(positions, edges)).toEqual([]);
    expect(overlaps(positions)).toEqual([]);
    const firstBand = rowsOf(positions, ["first", "firstYes", "firstNo"]);
    const secondBand = rowsOf(positions, ["second", "secondOnly"]);
    const thirdBand = rowsOf(positions, ["third", "thirdYes", "thirdNo"]);
    expect(Math.max(...firstBand)).toBeLessThan(Math.min(...secondBand));
    expect(Math.max(...secondBand)).toBeLessThan(Math.min(...thirdBand));
  });

  it("keeps both sides apart when the branches merge again", () => {
    const { nodes, edges } = graph(
      ["trigger", "exists", "cast", "alert"],
      [
        ["trigger", "exists"],
        ["exists", "cast", "true"],
        ["exists", "alert", "false"],
        ["alert", "cast"],
      ]
    );

    const positions = computeAutoLayout(nodes, edges);

    expect(rowOf(positions, "cast")).toBeLessThan(rowOf(positions, "exists"));
    expect(rowOf(positions, "alert")).toBeGreaterThan(
      rowOf(positions, "exists")
    );
  });

  it("lays out a loop whose body feeds back into the loop node", () => {
    const { nodes, edges } = graph(
      ["trigger", "loop", "body", "collect"],
      [
        ["trigger", "loop"],
        ["loop", "body", "loop"],
        ["body", "loop"],
        ["loop", "collect", "done"],
      ]
    );

    const positions = computeAutoLayout(nodes, edges);

    expect(positions.size).toBe(4);
    expect(overlaps(positions)).toEqual([]);
    expect(columnOf(positions, "body")).toBeGreaterThan(
      columnOf(positions, "loop")
    );
  });

  it("places disconnected nodes without stacking them on the flow", () => {
    const { nodes, edges } = graph(
      ["trigger", "a", "orphan1", "orphan2"],
      [["trigger", "a"]]
    );

    const positions = computeAutoLayout(nodes, edges);

    expect(positions.size).toBe(4);
    expect(overlaps(positions)).toEqual([]);
  });

  it("ignores the placeholder add nodes", () => {
    const nodes: TestNode[] = [
      { id: "trigger", type: "trigger", position: { x: 0, y: 0 } },
      { id: "a", type: "action", position: { x: 0, y: 0 } },
      { id: "add-1", type: "add", position: { x: 0, y: 0 } },
    ];
    const edges: TestEdge[] = [
      { source: "trigger", target: "a" },
      { source: "a", target: "add-1" },
    ];

    const positions = computeAutoLayout(nodes, edges);

    expect(positions.has("add-1")).toBe(false);
    expect(positions.size).toBe(2);
  });
});
