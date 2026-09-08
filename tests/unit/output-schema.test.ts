import { describe, expect, it } from "vitest";

import { synthesizeOutputSchema } from "@/lib/mcp/output-schema";
import type { PluginAction } from "@/plugins/registry";

function action(overrides: Partial<PluginAction>): PluginAction {
  return {
    slug: "a",
    label: "A",
    description: "",
    category: "web3",
    stepFunction: "aStep",
    stepImportPath: "a",
    configFields: [],
    ...overrides,
  };
}

describe("synthesizeOutputSchema", () => {
  it("synthesizes an object schema from outputFields", () => {
    const result = synthesizeOutputSchema(
      action({
        outputFields: [
          { field: "success", description: "Whether it worked" },
          { field: "balance", description: "Balance in ETH" },
        ],
      })
    );
    expect(result).toEqual({
      type: "object",
      properties: {
        success: { description: "Whether it worked" },
        balance: { description: "Balance in ETH" },
      },
    });
  });

  it("returns null when the action declares no outputs", () => {
    expect(synthesizeOutputSchema(action({}))).toBeNull();
    expect(synthesizeOutputSchema(action({ outputFields: [] }))).toBeNull();
  });

  it("prefers an explicitly declared outputSchema over synthesis", () => {
    const declared = { type: "object", properties: { x: { type: "number" } } };
    const result = synthesizeOutputSchema(
      action({
        outputSchema: declared,
        outputFields: [{ field: "ignored", description: "ignored" }],
      })
    );
    expect(result).toBe(declared);
  });
});
