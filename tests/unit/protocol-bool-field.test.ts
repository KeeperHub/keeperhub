import { describe, expect, it } from "vitest";
import { protocolBoolFieldValue } from "@/components/workflow/config/protocol-fields/protocol-bool-field";

// Built from code points: the formatter turns an escape into the raw character.
function hidden(code: number): string {
  return String.fromCodePoint(code);
}

function flagged(saved: unknown): unknown {
  const { value, unrecognized } = protocolBoolFieldValue(saved, "true");
  expect(value).toBe("");
  expect(unrecognized).toBeDefined();
  return unrecognized;
}

const literal = (text: string, shortened = false): unknown => ({
  literal: text,
  shortened,
});

// The action schema tells agents a Solidity bool is a JSON boolean, so the
// editor has to show one saved that way, not the default or an empty select.
describe("protocolBoolFieldValue", () => {
  it.each([
    [true, "false", "true"],
    [false, "true", "false"],
    ["true", undefined, "true"],
    ["false", "true", "false"],
    ["{{@a:A.flag}}", undefined, "{{@a:A.flag}}"],
    [undefined, "false", "false"],
    ["", "true", "true"],
    [undefined, undefined, ""],
  ])("shows saved %j with default %j as %j", (saved, defaultValue, shown) => {
    expect(protocolBoolFieldValue(saved, defaultValue)).toEqual({
      value: shown,
    });
  });

  // Save validation refuses these, so they must not read as unset or as the
  // default.
  it.each([
    [0, "0"],
    [1, "1"],
    [null, "null"],
    ["yes", '"yes"'],
    ["TRUE", '"TRUE"'],
  ])("shows saved %j as the value %s", (saved, text) => {
    expect(flagged(saved)).toEqual(literal(text));
  });

  it.each([
    [{ a: 1 }, "an object"],
    [{}, "an empty object"],
    [[1, 2, 3], "a list of 3 items"],
    [[1], "a list of 1 item"],
    [[], "an empty list"],
    [new Array(1_000_000).fill(12_345), "a list of 1000000 items"],
  ])("describes saved %j as %s", (saved, kind) => {
    expect(flagged(saved)).toEqual({ kind });
  });

  it("writes hidden characters out as escapes", () => {
    const saved = `a${hidden(0x20_2e)}b${hidden(0x20_0b)}c${hidden(0x85)}d${hidden(0x20_28)}e${hidden(0xfe_0f)}f${hidden(0xe_00_41)}g`;
    expect(flagged(saved)).toEqual(
      literal('"a\\u202eb\\u200bc\\u0085d\\u2028e\\ufe0ff\\u{e0041}g"')
    );
  });

  it("shows at most 60 whole characters and says when it cut", () => {
    const emoji = hidden(0x1_f6_00);
    expect(flagged("x".repeat(60))).toEqual(literal(`"${"x".repeat(60)}"`));
    expect(flagged("x".repeat(61))).toEqual(
      literal(`"${"x".repeat(60)}"`, true)
    );
    expect(flagged(`${"x".repeat(59)}${emoji}`)).toEqual(
      literal(`"${"x".repeat(59)}${emoji}"`)
    );
    expect(flagged(`${"x".repeat(59)}${emoji}z`)).toEqual(
      literal(`"${"x".repeat(59)}${emoji}"`, true)
    );
  });

  it("keeps a value of hidden characters within 60 once escaped", () => {
    expect(flagged(hidden(0xe_00_41).repeat(100))).toEqual(
      literal(`"${"\\u{e0041}".repeat(6)}"`, true)
    );
  });

  // Escapes are added whole or not at all.
  it.each([
    [`${"x".repeat(59)}\\yyyy`, `"${"x".repeat(59)}"`],
    [`${"x".repeat(58)}\\yyyy`, `"${"x".repeat(58)}\\\\"`],
    [`${"x".repeat(59)}"yyyy`, `"${"x".repeat(59)}"`],
  ])("never splits an escape for %j", (saved, text) => {
    expect(flagged(saved)).toEqual(literal(text, true));
  });
});
