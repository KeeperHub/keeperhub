import { describe, expect, it } from "vitest";
import { generateAIActionPrompts } from "@/plugins/registry";

function exampleFor(actionType: string): Record<string, unknown> {
  const line = generateAIActionPrompts()
    .split("\n")
    .find((entry) => entry.includes(`(${actionType}): `));
  if (!line) {
    throw new Error(`no prompt line for ${actionType}`);
  }
  return JSON.parse(line.slice(line.indexOf("{"))) as Record<string, unknown>;
}

describe("generateAIActionPrompts", () => {
  it("includes a conditional field whose condition holds for the example", () => {
    const example = exampleFor("data/encode");

    // The example operation is encode, so the text format is in play and
    // required. Leaving it out would have the model emit configs that fail
    // MISSING_REQUIRED_FIELD on save.
    expect(example.operation).toBe("encode");
    expect(example.format).toBe("bytes32");
    // Padding depends on both the operation and a fixed-size format, both of
    // which the example already carries.
    expect(example.padding).toBe("right");
  });

  it("leaves out a conditional field whose condition does not hold", () => {
    const example = exampleFor("data/encode");

    expect(example).not.toHaveProperty("numberFormat");
  });

  it("emits one parseable line per action", () => {
    for (const line of generateAIActionPrompts().split("\n")) {
      expect(line).toMatch(/^- .+ \([a-z0-9-]+\/[a-z0-9-]+\): \{/);
      expect(() => JSON.parse(line.slice(line.indexOf("{")))).not.toThrow();
    }
  });
});
