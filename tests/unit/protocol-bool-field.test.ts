import { describe, expect, it } from "vitest";
import { protocolBoolFieldValue } from "@/components/workflow/config/protocol-fields/protocol-bool-field";

// Built from code points: the formatter turns an escape into the raw character.
function hidden(code: number): string {
  return String.fromCodePoint(code);
}

function unrecognized(saved: unknown): { shown: string; full: string } {
  const result = protocolBoolFieldValue(saved, "true").unrecognized;
  if (!result) {
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
    [{ a: 1 }, "{…}"],
    [{}, "{}"],
    [[1, 2, 3], "[3 items]"],
    [[1], "[1 item]"],
    [[], "[]"],
  ])("flags saved %j as %s", (saved, shown) => {
    expect(protocolBoolFieldValue(saved, "true")).toEqual({
      value: "",
      unrecognized: { shown, full: shown },
    });
  });

  it("sums up a huge array instead of stringifying it", () => {
    expect(unrecognized(new Array(1_000_000).fill(12_345)).shown).toBe(
      "[1000000 items]"
    );
  });

  it("writes hidden characters out as escapes", () => {
    const saved = `a${hidden(0x20_2e)}b${hidden(0x20_0b)}c${hidden(0x85)}d${hidden(0x20_28)}e${hidden(0x20_29)}f${hidden(0x7f)}g${hidden(0x20_60)}h${hidden(0xe_00_41)}i`;
    expect(unrecognized(saved).shown).toBe(
      '"a\\u202eb\\u200bc\\u0085d\\u2028e\\u2029f\\u007fg\\u2060h\\u{e0041}i"'
    );
  });

  it("cuts at 60 and 1000 whole characters, the mark outside the quotes", () => {
    const { shown, full } = unrecognized(
      `${"x".repeat(998)}\u{1F600}${"z".repeat(10)}`
    );
    expect(shown).toBe(`"${"x".repeat(60)}"…`);
    expect(full).toBe(`"${"x".repeat(998)}\u{1F600}z"…`);
  });

  it("does not mark a value that fits", () => {
    const { shown, full } = unrecognized("x".repeat(999));
    expect(full).toBe(`"${"x".repeat(999)}"`);
    expect(shown).toBe(`"${"x".repeat(60)}"…`);
  });

  // The cut is made before the value is quoted, so an escape is never split.
  it.each([
    [`${"x".repeat(59)}\\yyyy`, `"${"x".repeat(59)}\\\\"…`],
    [`${"x".repeat(59)}${hidden(0x20_2e)}yyyy`, `"${"x".repeat(59)}\\u202e"…`],
    [`${"x".repeat(59)}"yyyy`, `"${"x".repeat(59)}\\""…`],
  ])("keeps whole escapes at the cut for %j", (saved, shown) => {
    expect(unrecognized(saved).shown).toBe(shown);
  });
});
