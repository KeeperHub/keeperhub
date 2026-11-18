import { describe, expect, it } from "vitest";
import { protocolBoolFieldValue } from "@/components/workflow/config/protocol-fields/protocol-bool-field";

// Built from code points: the formatter turns an escape into the raw character.
function hidden(code: number): string {
  return String.fromCodePoint(code);
}

function unrecognized(saved: unknown): string {
  const result = protocolBoolFieldValue(saved, "true").unrecognized;
  if (result === undefined) {
    throw new Error(`${String(saved)} was not flagged`);
  }
  return result;
}

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
    [{ a: 1 }, "(object)"],
    [{}, "(empty object)"],
    [[1, 2, 3], "(list of 3 items)"],
    [[1], "(list of 1 item)"],
    [[], "(empty list)"],
  ])("flags saved %j as %s", (saved, shown) => {
    expect(protocolBoolFieldValue(saved, "true")).toEqual({
      value: "",
      unrecognized: shown,
    });
  });

  it("sums up a huge array instead of stringifying it", () => {
    expect(unrecognized(new Array(1_000_000).fill(12_345))).toBe(
      "(list of 1000000 items)"
    );
  });

  it("writes hidden characters out as escapes", () => {
    const saved = `a${hidden(0x20_2e)}b${hidden(0x20_0b)}c${hidden(0x85)}d${hidden(0x20_28)}e${hidden(0x20_60)}f${hidden(0xe_00_41)}g`;
    expect(unrecognized(saved)).toBe(
      '"a\\u202eb\\u200bc\\u0085d\\u2028e\\u2060f\\u{e0041}g"'
    );
  });

  it("shows at most 60 characters, cut at a whole character, the mark outside", () => {
    expect(unrecognized("x".repeat(60))).toBe(`"${"x".repeat(60)}"`);
    expect(unrecognized("x".repeat(61))).toBe(`"${"x".repeat(60)}"…`);
    const emoji = hidden(0x1_f6_00);
    expect(unrecognized(`${"x".repeat(59)}${emoji}`)).toBe(
      `"${"x".repeat(59)}${emoji}"`
    );
    expect(unrecognized(`${"x".repeat(59)}${emoji}z`)).toBe(
      `"${"x".repeat(59)}${emoji}"…`
    );
  });

  // A value of hidden characters must not grow past the limit once escaped.
  it("keeps a value of hidden characters within 60 once escaped", () => {
    const shown = unrecognized(hidden(0xe_00_41).repeat(100));
    expect(shown).toBe(`"${"\\u{e0041}".repeat(6)}"…`);
  });

  // Escapes are added whole or not at all.
  it.each([
    [`${"x".repeat(59)}\\yyyy`, `"${"x".repeat(59)}"…`],
    [`${"x".repeat(58)}\\yyyy`, `"${"x".repeat(58)}\\\\"…`],
    [`${"x".repeat(59)}"yyyy`, `"${"x".repeat(59)}"…`],
  ])("never splits an escape for %j", (saved, shown) => {
    expect(unrecognized(saved)).toBe(shown);
  });
});
