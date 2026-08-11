import { describe, expect, it } from "vitest";
import {
  resolveForEachSyntheticOutput,
  traverseDotPath,
} from "@/lib/workflow/nodes/for-each/utils";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ForEachNode = {
  id: string;
  data: {
    config?: Record<string, unknown>;
  };
};

function makeNode(
  id: string,
  _label: string,
  config?: Record<string, unknown>
): ForEachNode {
  return {
    id,
    data: {
      config,
    },
  };
}

// ---------------------------------------------------------------------------
// traverseDotPath
// ---------------------------------------------------------------------------

describe("traverseDotPath", () => {
  it("resolves a simple single-level path", () => {
    expect(traverseDotPath({ a: 1 }, "a")).toBe(1);
  });

  it("resolves a nested multi-level path", () => {
    expect(traverseDotPath({ a: { b: { c: 42 } } }, "a.b.c")).toBe(42);
  });

  it("returns null for a missing key at the leaf level", () => {
    expect(traverseDotPath({ a: 1 }, "b")).toBeNull();
  });

  it("returns null when the path traverses through an array", () => {
    expect(traverseDotPath({ a: [1, 2, 3] }, "a.0")).toBeNull();
  });

  it("returns null when the path traverses through a primitive", () => {
    expect(traverseDotPath({ a: "hello" }, "a.b")).toBeNull();
  });

  it("returns null when path is an empty string", () => {
    const root = { x: 10 };
    // An empty string split by "." produces [""], so root[""] is undefined.
    expect(traverseDotPath(root, "")).toBeNull();
  });

  it("returns null when root is null", () => {
    expect(traverseDotPath(null, "a")).toBeNull();
  });

  it("returns null when root is undefined", () => {
    expect(traverseDotPath(undefined, "a")).toBeNull();
  });

  it("returns null when an intermediate key does not exist", () => {
    expect(traverseDotPath({ a: { b: 1 } }, "a.x.y")).toBeNull();
  });

  it("returns the full nested object when path resolves to an object", () => {
    const nested = { c: 3, d: 4 };
    expect(traverseDotPath({ a: { b: nested } }, "a.b")).toEqual(nested);
  });

  it("returns null when traversing through a number", () => {
    expect(traverseDotPath({ a: 42 }, "a.toString")).toBeNull();
  });

  it("returns null when traversing through a boolean", () => {
    expect(traverseDotPath({ a: true }, "a.b")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveForEachSyntheticOutput
// ---------------------------------------------------------------------------

describe("resolveForEachSyntheticOutput", () => {
  it("returns null when node has no config", () => {
    const node = makeNode("n1", "For Each");
    const result = resolveForEachSyntheticOutput(node, {}, {});
    expect(result).toBeNull();
  });

  it("returns null when config has no arraySource", () => {
    const node = makeNode("n1", "For Each", { someOtherField: "value" });
    const result = resolveForEachSyntheticOutput(node, {}, {});
    expect(result).toBeNull();
  });

  it("returns null when arraySource is not a valid template reference", () => {
    const node = makeNode("n1", "For Each", {
      arraySource: "just-a-plain-string",
    });
    const result = resolveForEachSyntheticOutput(node, {}, {});
    expect(result).toBeNull();
  });

  it("returns null when arraySource template has invalid format", () => {
    const node = makeNode("n1", "For Each", {
      arraySource: "{{invalid}}",
    });
    const result = resolveForEachSyntheticOutput(node, {}, {});
    expect(result).toBeNull();
  });

  it("returns null when source node has no output in either log", () => {
    const node = makeNode("n1", "For Each", {
      arraySource: "{{@src:Source.items}}",
    });
    const result = resolveForEachSyntheticOutput(node, {}, {});
    expect(result).toBeNull();
  });

  it("returns null when source node output is null", () => {
    const node = makeNode("n1", "For Each", {
      arraySource: "{{@src:Source.items}}",
    });
    const executionLogs = { src: { output: null } };
    const result = resolveForEachSyntheticOutput(node, executionLogs, {});
    expect(result).toBeNull();
  });

  it("returns null when field path resolves to a non-array value", () => {
    const node = makeNode("n1", "For Each", {
      arraySource: "{{@src:Source.count}}",
    });
    const executionLogs = { src: { output: { count: 42 } } };
    const result = resolveForEachSyntheticOutput(node, executionLogs, {});
    expect(result).toBeNull();
  });

  it("returns null when field path resolves to a string", () => {
    const node = makeNode("n1", "For Each", {
      arraySource: "{{@src:Source.name}}",
    });
    const executionLogs = { src: { output: { name: "hello" } } };
    const result = resolveForEachSyntheticOutput(node, executionLogs, {});
    expect(result).toBeNull();
  });

  it("returns null when the resolved array is empty", () => {
    const node = makeNode("n1", "For Each", {
      arraySource: "{{@src:Source.items}}",
    });
    const executionLogs = { src: { output: { items: [] } } };
    const result = resolveForEachSyntheticOutput(node, executionLogs, {});
    expect(result).toBeNull();
  });

  it("resolves a top-level array with no field path", () => {
    const node = makeNode("n1", "For Each", {
      arraySource: "{{@src:Source}}",
    });
    const executionLogs = {
      src: { output: ["apple", "banana", "cherry"] },
    };
    const result = resolveForEachSyntheticOutput(node, executionLogs, {});
    expect(result).toEqual({
      currentItem: "apple",
      index: 0,
      totalItems: 3,
    });
  });

  it("resolves an array at a single-level field path", () => {
    const node = makeNode("n1", "For Each", {
      arraySource: "{{@src:Source.items}}",
    });
    const items = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const executionLogs = { src: { output: { items } } };
    const result = resolveForEachSyntheticOutput(node, executionLogs, {});
    expect(result).toEqual({
      currentItem: { id: 1 },
      index: 0,
      totalItems: 3,
    });
  });

  it("resolves an array at a nested field path", () => {
    const node = makeNode("n1", "For Each", {
      arraySource: "{{@src:Source.data.items}}",
    });
    const items = [{ name: "a" }, { name: "b" }];
    const executionLogs = { src: { output: { data: { items } } } };
    const result = resolveForEachSyntheticOutput(node, executionLogs, {});
    expect(result).toEqual({
      currentItem: { name: "a" },
      index: 0,
      totalItems: 2,
    });
  });

  it("prefers executionLogs over lastLogs", () => {
    const node = makeNode("n1", "For Each", {
      arraySource: "{{@src:Source}}",
    });
    const executionLogs = { src: { output: ["exec-a", "exec-b"] } };
    const lastLogs = { src: { output: ["last-x", "last-y", "last-z"] } };
    const result = resolveForEachSyntheticOutput(node, executionLogs, lastLogs);
    expect(result).toEqual({
      currentItem: "exec-a",
      index: 0,
      totalItems: 2,
    });
  });

  it("falls back to lastLogs when executionLogs has no entry", () => {
    const node = makeNode("n1", "For Each", {
      arraySource: "{{@src:Source}}",
    });
    const lastLogs = { src: { output: ["fallback-1", "fallback-2"] } };
    const result = resolveForEachSyntheticOutput(node, {}, lastLogs);
    expect(result).toEqual({
      currentItem: "fallback-1",
      index: 0,
      totalItems: 2,
    });
  });

  it("falls back to lastLogs when executionLogs output is undefined", () => {
    const node = makeNode("n1", "For Each", {
      arraySource: "{{@src:Source}}",
    });
    const executionLogs = { src: { output: undefined } };
    const lastLogs = { src: { output: [10, 20, 30] } };
    const result = resolveForEachSyntheticOutput(node, executionLogs, lastLogs);
    expect(result).toEqual({
      currentItem: 10,
      index: 0,
      totalItems: 3,
    });
  });

  it("falls back to lastLogs when executionLogs output is null", () => {
    const node = makeNode("n1", "For Each", {
      arraySource: "{{@src:Source}}",
    });
    const executionLogs = { src: { output: null } };
    const lastLogs = { src: { output: ["a"] } };
    const result = resolveForEachSyntheticOutput(node, executionLogs, lastLogs);
    expect(result).toEqual({
      currentItem: "a",
      index: 0,
      totalItems: 1,
    });
  });

  it("returns the first element as currentItem", () => {
    const node = makeNode("n1", "For Each", {
      arraySource: "{{@src:Source}}",
    });
    const executionLogs = {
      src: { output: [{ first: true }, { first: false }] },
    };
    const result = resolveForEachSyntheticOutput(node, executionLogs, {});
    expect(result?.currentItem).toEqual({ first: true });
  });

  it("returns totalItems matching the array length", () => {
    const node = makeNode("n1", "For Each", {
      arraySource: "{{@src:Source}}",
    });
    const executionLogs = {
      src: { output: [1, 2, 3, 4, 5] },
    };
    const result = resolveForEachSyntheticOutput(node, executionLogs, {});
    expect(result?.totalItems).toBe(5);
  });

  it("always returns index as 0", () => {
    const node = makeNode("n1", "For Each", {
      arraySource: "{{@src:Source}}",
    });
    const executionLogs = {
      src: { output: [100, 200, 300] },
    };
    const result = resolveForEachSyntheticOutput(node, executionLogs, {});
    expect(result?.index).toBe(0);
  });

  // -------------------------------------------------------------------------
  // mapExpression tests
  // -------------------------------------------------------------------------

  it("applies mapExpression to extract a field from the first element", () => {
    const node = makeNode("n1", "For Each", {
      arraySource: "{{@src:Source.items}}",
      mapExpression: "name",
    });
    const items = [
      { name: "Alice", age: 30 },
      { name: "Bob", age: 25 },
    ];
    const executionLogs = { src: { output: { items } } };
    const result = resolveForEachSyntheticOutput(node, executionLogs, {});
    expect(result).toEqual({
      currentItem: "Alice",
      index: 0,
      totalItems: 2,
    });
  });

  it("applies mapExpression with a nested dot path", () => {
    const node = makeNode("n1", "For Each", {
      arraySource: "{{@src:Source.records}}",
      mapExpression: "data.nested.field",
    });
    const records = [
      { data: { nested: { field: "deep-value" } } },
      { data: { nested: { field: "other" } } },
    ];
    const executionLogs = { src: { output: { records } } };
    const result = resolveForEachSyntheticOutput(node, executionLogs, {});
    expect(result).toEqual({
      currentItem: "deep-value",
      index: 0,
      totalItems: 2,
    });
  });

  it("keeps full element when mapExpression targets a missing field", () => {
    const node = makeNode("n1", "For Each", {
      arraySource: "{{@src:Source.items}}",
      mapExpression: "nonExistent",
    });
    const items = [{ name: "Alice" }, { name: "Bob" }];
    const executionLogs = { src: { output: { items } } };
    const result = resolveForEachSyntheticOutput(node, executionLogs, {});
    // traverseDotPath returns null for missing keys, so the guard
    // catches it and currentItem stays as the full element.
    expect(result).toEqual({
      currentItem: { name: "Alice" },
      index: 0,
      totalItems: 2,
    });
  });

  it("keeps full element when mapExpression is applied to a non-object currentItem", () => {
    const node = makeNode("n1", "For Each", {
      arraySource: "{{@src:Source}}",
      mapExpression: "field",
    });
    // Array of primitives -- currentItem is a string, not an object
    const executionLogs = {
      src: { output: ["hello", "world"] },
    };
    const result = resolveForEachSyntheticOutput(node, executionLogs, {});
    expect(result).toEqual({
      currentItem: "hello",
      index: 0,
      totalItems: 2,
    });
  });

  it("extracts an array field via mapExpression for nested For Each", () => {
    const node = makeNode("n1", "For Each", {
      arraySource: "{{@src:Source.groups}}",
      mapExpression: "members",
    });
    const groups = [{ members: ["Alice", "Bob"] }, { members: ["Charlie"] }];
    const executionLogs = { src: { output: { groups } } };
    const result = resolveForEachSyntheticOutput(node, executionLogs, {});
    // mapExpression extracts the "members" array from the first group
    expect(result).toEqual({
      currentItem: ["Alice", "Bob"],
      index: 0,
      totalItems: 2,
    });
  });

  it("returns full first element when no mapExpression is configured", () => {
    const node = makeNode("n1", "For Each", {
      arraySource: "{{@src:Source.items}}",
    });
    const element = { id: 1, name: "First", tags: ["a", "b"] };
    const executionLogs = {
      src: {
        output: { items: [element, { id: 2, name: "Second", tags: [] }] },
      },
    };
    const result = resolveForEachSyntheticOutput(node, executionLogs, {});
    expect(result).toEqual({
      currentItem: element,
      index: 0,
      totalItems: 2,
    });
  });

  it("skips mapExpression when it is an empty string", () => {
    const node = makeNode("n1", "For Each", {
      arraySource: "{{@src:Source.items}}",
      mapExpression: "",
    });
    const element = { id: 1, value: "test" };
    const executionLogs = {
      src: { output: { items: [element] } },
    };
    const result = resolveForEachSyntheticOutput(node, executionLogs, {});
    // Empty mapExpression is falsy, so it is not applied
    expect(result).toEqual({
      currentItem: element,
      index: 0,
      totalItems: 1,
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases for field path resolution
  // -------------------------------------------------------------------------

  it("returns null when field path traverses through a non-object", () => {
    const node = makeNode("n1", "For Each", {
      arraySource: "{{@src:Source.a.b.c}}",
    });
    const executionLogs = { src: { output: { a: "not-an-object" } } };
    const result = resolveForEachSyntheticOutput(node, executionLogs, {});
    expect(result).toBeNull();
  });

  it("returns null when field path resolves to undefined", () => {
    const node = makeNode("n1", "For Each", {
      arraySource: "{{@src:Source.missing}}",
    });
    const executionLogs = { src: { output: { present: [1] } } };
    const result = resolveForEachSyntheticOutput(node, executionLogs, {});
    expect(result).toBeNull();
  });

  it("handles a deeply nested field path correctly", () => {
    const node = makeNode("n1", "For Each", {
      arraySource: "{{@src:Source.level1.level2.level3.data}}",
    });
    const deepData = [{ v: 1 }, { v: 2 }];
    const executionLogs = {
      src: {
        output: {
          level1: { level2: { level3: { data: deepData } } },
        },
      },
    };
    const result = resolveForEachSyntheticOutput(node, executionLogs, {});
    expect(result).toEqual({
      currentItem: { v: 1 },
      index: 0,
      totalItems: 2,
    });
  });

  it("handles node IDs with special characters in the template", () => {
    const node = makeNode("n1", "For Each", {
      arraySource: "{{@node-123:My Source}}",
    });
    const executionLogs = {
      "node-123": { output: ["x", "y"] },
    };
    const result = resolveForEachSyntheticOutput(node, executionLogs, {});
    expect(result).toEqual({
      currentItem: "x",
      index: 0,
      totalItems: 2,
    });
  });
});

// ---------------------------------------------------------------------------
// Nested For Each chain resolution
// ---------------------------------------------------------------------------

describe("resolveForEachSyntheticOutput - nested chain resolution", () => {
  it("resolves inner For Each referencing parent's currentItem field", () => {
    const outer = makeNode("fe-outer", "For Each", {
      actionType: "For Each",
      arraySource: "{{@trigger:Trigger.groups}}",
    });
    const inner = makeNode("fe-inner", "For Each", {
      actionType: "For Each",
      arraySource: "{{@fe-outer:Outer.currentItem.members}}",
    });
    const executionLogs = {
      trigger: {
        output: {
          groups: [
            { members: [{ name: "Alice" }, { name: "Bob" }] },
            { members: [{ name: "Charlie" }] },
          ],
        },
      },
    };
    const allNodes = [outer, inner];
    const result = resolveForEachSyntheticOutput(
      inner,
      executionLogs,
      {},
      allNodes
    );
    expect(result).toEqual({
      currentItem: { name: "Alice" },
      index: 0,
      totalItems: 2,
    });
  });

  it("applies parent's mapExpression before resolving inner array", () => {
    const outer = makeNode("fe-outer", "For Each", {
      actionType: "For Each",
      arraySource: "{{@trigger:Trigger.data}}",
      mapExpression: "nested",
    });
    const inner = makeNode("fe-inner", "For Each", {
      actionType: "For Each",
      arraySource: "{{@fe-outer:Outer.currentItem.items}}",
    });
    const executionLogs = {
      trigger: {
        output: {
          data: [
            { nested: { items: [{ id: 1 }, { id: 2 }] } },
            { nested: { items: [{ id: 3 }] } },
          ],
        },
      },
    };
    const allNodes = [outer, inner];
    const result = resolveForEachSyntheticOutput(
      inner,
      executionLogs,
      {},
      allNodes
    );
    // Parent's mapExpression extracts "nested", so currentItem = { items: [...] }
    // Inner resolves currentItem.items from that
    expect(result).toEqual({
      currentItem: { id: 1 },
      index: 0,
      totalItems: 2,
    });
  });

  it("resolves 3 levels of nested For Each", () => {
    const level1 = makeNode("fe-1", "For Each", {
      actionType: "For Each",
      arraySource: "{{@src:Source.departments}}",
    });
    const level2 = makeNode("fe-2", "For Each", {
      actionType: "For Each",
      arraySource: "{{@fe-1:Level1.currentItem.teams}}",
    });
    const level3 = makeNode("fe-3", "For Each", {
      actionType: "For Each",
      arraySource: "{{@fe-2:Level2.currentItem.members}}",
    });
    const executionLogs = {
      src: {
        output: {
          departments: [
            {
              teams: [
                { members: [{ name: "Alice" }, { name: "Bob" }] },
                { members: [{ name: "Charlie" }] },
              ],
            },
          ],
        },
      },
    };
    const allNodes = [level1, level2, level3];
    const result = resolveForEachSyntheticOutput(
      level3,
      executionLogs,
      {},
      allNodes
    );
    expect(result).toEqual({
      currentItem: { name: "Alice" },
      index: 0,
      totalItems: 2,
    });
  });

  it("prevents infinite recursion on circular references", () => {
    const nodeA = makeNode("fe-a", "For Each", {
      actionType: "For Each",
      arraySource: "{{@fe-b:B.currentItem.items}}",
    });
    const nodeB = makeNode("fe-b", "For Each", {
      actionType: "For Each",
      arraySource: "{{@fe-a:A.currentItem.items}}",
    });
    const allNodes = [nodeA, nodeB];
    // Should return null instead of infinite looping
    const result = resolveForEachSyntheticOutput(nodeA, {}, {}, allNodes);
    expect(result).toBeNull();
  });

  it("falls back gracefully when parent has no arraySource", () => {
    const outer = makeNode("fe-outer", "For Each", {
      actionType: "For Each",
    });
    const inner = makeNode("fe-inner", "For Each", {
      actionType: "For Each",
      arraySource: "{{@fe-outer:Outer.currentItem.items}}",
    });
    const allNodes = [outer, inner];
    const result = resolveForEachSyntheticOutput(inner, {}, {}, allNodes);
    expect(result).toBeNull();
  });

  it("falls back to execution logs when source is not a For Each", () => {
    const httpNode = makeNode("http-1", "HTTP Request", {
      actionType: "HTTP Request",
    });
    const inner = makeNode("fe-inner", "For Each", {
      actionType: "For Each",
      arraySource: "{{@http-1:HTTP Request.items}}",
    });
    const executionLogs = {
      "http-1": { output: { items: [{ a: 1 }, { a: 2 }] } },
    };
    const allNodes = [httpNode, inner];
    const result = resolveForEachSyntheticOutput(
      inner,
      executionLogs,
      {},
      allNodes
    );
    expect(result).toEqual({
      currentItem: { a: 1 },
      index: 0,
      totalItems: 2,
    });
  });

  it("works without allNodes (backward compatible)", () => {
    const node = makeNode("n1", "For Each", {
      arraySource: "{{@src:Source.items}}",
    });
    const executionLogs = {
      src: { output: { items: [{ id: 1 }] } },
    };
    // No allNodes passed -- existing behavior preserved
    const result = resolveForEachSyntheticOutput(node, executionLogs, {});
    expect(result).toEqual({
      currentItem: { id: 1 },
      index: 0,
      totalItems: 1,
    });
  });

  it("resolves inner For Each from lastLogs when parent uses lastLogs", () => {
    const outer = makeNode("fe-outer", "For Each", {
      actionType: "For Each",
      arraySource: "{{@trigger:Trigger.items}}",
    });
    const inner = makeNode("fe-inner", "For Each", {
      actionType: "For Each",
      arraySource: "{{@fe-outer:Outer.currentItem.children}}",
    });
    const lastLogs = {
      trigger: {
        output: {
          items: [{ children: ["x", "y"] }, { children: ["z"] }],
        },
      },
    };
    const allNodes = [outer, inner];
    const result = resolveForEachSyntheticOutput(inner, {}, lastLogs, allNodes);
    expect(result).toEqual({
      currentItem: "x",
      index: 0,
      totalItems: 2,
    });
  });
});
