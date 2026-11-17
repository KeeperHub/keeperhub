import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { readOwnField } from "@/lib/utils/read-own-field";
import { processTemplate } from "@/lib/utils/template";
import { resolveFromOutputData } from "@/lib/workflow/executor/executor.workflow";
import { traverseDotPath } from "@/lib/workflow/nodes/for-each/utils";

const OUTPUT = {
  data: {
    recipes: [{ name: "Soup", tags: ["hot"] }],
    note: "abc",
    owner: { name: "alice" },
  },
};

const INTERNAL_PATHS = [
  "owner.constructor",
  "owner.constructor.constructor",
  "owner.__proto__",
  "owner.toString",
  "owner.hasOwnProperty",
  "recipes.constructor",
  "note.constructor",
];

describe("template paths read only a step's own output data", () => {
  it("keeps resolving user data, including arrays and length", () => {
    expect(resolveFromOutputData(OUTPUT, "recipes[0].tags[0]")).toBe("hot");
    expect(resolveFromOutputData(OUTPUT, "owner.name")).toBe("alice");
    expect(resolveFromOutputData(OUTPUT, "recipes.length")).toBe(1);
    expect(resolveFromOutputData(OUTPUT, "note.length")).toBe(3);
  });

  it("never resolves inherited or internal members", () => {
    for (const path of INTERNAL_PATHS) {
      expect(resolveFromOutputData(OUTPUT, path)).toBeUndefined();
    }
  });

  it("renders internal members as empty in label templates", () => {
    const outputs = { n1: { label: "Step", data: OUTPUT.data } };
    expect(processTemplate("{{Step.owner.name}}", outputs)).toBe("alice");
    for (const path of INTERNAL_PATHS) {
      expect(processTemplate(`{{Step.${path}}}`, outputs)).not.toContain(
        "function"
      );
    }
  });

  it("does not traverse inherited members in For Each paths", () => {
    expect(traverseDotPath(OUTPUT.data, "owner.name")).toBe("alice");
    expect(traverseDotPath(OUTPUT.data, "owner.constructor")).toBeNull();
  });

  it("refuses blocked and inherited keys on any value", () => {
    expect(readOwnField({ a: 1 }, "a")).toBe(1);
    expect(readOwnField({}, "constructor")).toBeUndefined();
    expect(readOwnField({ constructor: "x" }, "constructor")).toBeUndefined();
    expect(readOwnField("abc", "length")).toBe(3);
    expect(readOwnField(null, "a")).toBeUndefined();
  });
});
