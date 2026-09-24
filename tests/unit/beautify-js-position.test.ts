// Prettier parses the masked text, where every reference has been replaced by
// a shorter placeholder. Its column therefore counts masked characters, and a
// reference earlier on the line drags the number left - onto the middle of the
// user's own reference. The line is always right; only the column moves.

import { describe, expect, it } from "vitest";

import { beautifyJavaScript } from "@/lib/utils/beautify";

async function positionOf(source: string): Promise<string> {
  const outcome = await beautifyJavaScript(source);
  if (outcome.ok) {
    throw new Error("expected this source to fail parsing");
  }
  return outcome.error;
}

/**
 * Where the stray ";" actually sits, as a user would count it: 1-based line,
 * 1-based column. Computed rather than hardcoded, so the expectation cannot
 * drift from the fixture.
 */
function straySemicolonAt(source: string): { line: number; column: number } {
  const offset = source.indexOf(", ;") + 2;
  const before = source.slice(0, offset);
  const lastBreak = before.lastIndexOf("\n");
  return {
    line: before.split("\n").length,
    column: offset - lastBreak,
  };
}

describe("a JavaScript parse failure reports the user's column", () => {
  it("points past a reference on the same line, not into it", async () => {
    const source =
      "const a = [{{@n1:Some Very Long Node Label.result.value}}, ;];";
    const at = straySemicolonAt(source);
    expect(at).toEqual({ line: 1, column: 60 });
    expect(await positionOf(source)).toContain("(1:60)");
  });

  it("is unchanged when no reference precedes the error", async () => {
    const source = "const a = [1, ;];";
    const at = straySemicolonAt(source);
    expect(await positionOf(source)).toContain(`(${at.line}:${at.column})`);
  });

  it("counts every reference before the error, not just one", async () => {
    const source = "const a = [{{@n1:Alpha.value}}, {{@n2:Beta.value}}, ;];";
    const at = straySemicolonAt(source);
    expect(await positionOf(source)).toContain(`(${at.line}:${at.column})`);
  });

  it("keeps the line number and maps the column on a later line", async () => {
    const source =
      "const a = 1;\nconst b = [{{@n1:Some Very Long Node Label.result}}, ;];";
    const at = straySemicolonAt(source);
    expect(at.line).toBe(2);
    expect(await positionOf(source)).toContain(`(2:${at.column})`);
  });

  it("keeps Prettier's own wording", async () => {
    const source = "const a = [{{@n1:Alpha.value}}, ;];";
    expect(await positionOf(source)).toContain("Unexpected token");
  });
});
