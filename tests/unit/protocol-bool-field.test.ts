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

  // At runtime these encode as true (a non-empty string), so they must not
  // read as unset or as the default.
  it.each([
    [0, "0"],
    [1, "1"],
    [null, "null"],
    [{ a: 1 }, '{"a":1}'],
    ["yes", '"yes"'],
    ["TRUE", '"TRUE"'],
  ])("flags saved %j instead of showing the default", (saved, shown) => {
    expect(protocolBoolFieldValue(saved, "true")).toEqual({
      value: "",
      unrecognized: shown,
    });
  });

  it("shortens a long unrecognized value", () => {
    const { unrecognized } = protocolBoolFieldValue("x".repeat(200), "true");
    expect(unrecognized).toBe(`"${"x".repeat(59)}...`);
  });
});
