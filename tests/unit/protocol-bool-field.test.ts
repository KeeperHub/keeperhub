import { describe, expect, it } from "vitest";
import { protocolBoolFieldValue } from "@/components/workflow/config/protocol-fields/protocol-bool-field";

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
    [{ a: 1 }, "{…}"],
    [[1, 2, 3], "[3 items]"],
    ["yes", '"yes"'],
    ["TRUE", '"TRUE"'],
  ])("flags saved %j instead of showing the default", (saved, shown) => {
    expect(protocolBoolFieldValue(saved, "true")).toEqual({
      value: "",
      unrecognized: shown,
    });
  });

  it("writes control, bidi and separator characters out as escapes", () => {
    const { unrecognized } = protocolBoolFieldValue(
      "a\u202Eb\u200Bc\u0085d\u2028e\u2029f\u007Fg",
      "true"
    );
    expect(unrecognized).toBe(
      '"a\\u202eb\\u200bc\\u0085d\\u2028e\\u2029f\\u007fg"'
    );
  });

  it("cuts at 1000 whole characters, not UTF-16 units", () => {
    const { unrecognized } = protocolBoolFieldValue(
      `${"x".repeat(998)}\u{1F600}zz`,
      "true"
    );
    expect(unrecognized).toBe(`"${"x".repeat(998)}\u{1F600}…`);
  });

  it("marks a value cut at 1000 characters", () => {
    const { unrecognized } = protocolBoolFieldValue("x".repeat(5000), "true");
    expect(unrecognized).toBe(`"${"x".repeat(999)}…`);
  });

  it("sums up a huge array instead of stringifying it", () => {
    const started = performance.now();
    const { unrecognized } = protocolBoolFieldValue(
      new Array(1_000_000).fill(12_345),
      "true"
    );
    expect(unrecognized).toBe("[1000000 items]");
    expect(performance.now() - started).toBeLessThan(50);
  });
});
