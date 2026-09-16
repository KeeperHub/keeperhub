import { describe, expect, it } from "vitest";

import {
  type AbiOutputParam,
  structureAbiOutputs,
} from "@/plugins/web3/steps/structure-abi-result";

describe("structureAbiOutputs", () => {
  it("returns raw values when there are no declared outputs", () => {
    expect(structureAbiOutputs(["x"], [])).toEqual(["x"]);
  });

  it("wraps a single named scalar output under its name", () => {
    const outputs: AbiOutputParam[] = [{ name: "balance", type: "uint256" }];
    expect(structureAbiOutputs(["1000"], outputs)).toEqual({ balance: "1000" });
  });

  it("returns a single unnamed scalar output directly", () => {
    const outputs: AbiOutputParam[] = [{ name: "", type: "uint256" }];
    expect(structureAbiOutputs(["1000"], outputs)).toBe("1000");
  });

  it("names the components of a single unnamed tuple, recursing into nested tuples", () => {
    const outputs: AbiOutputParam[] = [
      {
        name: "",
        type: "tuple",
        components: [
          {
            name: "configuration",
            type: "tuple",
            components: [{ name: "data", type: "uint256" }],
          },
          { name: "liquidityIndex", type: "uint128" },
          { name: "aTokenAddress", type: "address" },
        ],
      },
    ];
    // Single auto-unwrapped tuple -> outputValues[0] is the component array.
    const value = [["12345"], "1000000", "0xabc"];
    expect(structureAbiOutputs([value], outputs)).toEqual({
      configuration: { data: "12345" },
      liquidityIndex: "1000000",
      aTokenAddress: "0xabc",
    });
  });

  it("falls back to unnamedOutput<index> for unnamed tuple components", () => {
    const outputs: AbiOutputParam[] = [
      {
        name: "slot0",
        type: "tuple",
        components: [
          { name: "", type: "uint160" },
          { name: "tick", type: "int24" },
        ],
      },
    ];
    expect(structureAbiOutputs([["123", "7"]], outputs)).toEqual({
      slot0: { unnamedOutput0: "123", tick: "7" },
    });
  });

  it("keys multiple outputs by name and structures nested tuples", () => {
    const outputs: AbiOutputParam[] = [
      { name: "ok", type: "bool" },
      {
        name: "info",
        type: "tuple",
        components: [{ name: "id", type: "uint256" }],
      },
      { name: "", type: "address" },
    ];
    expect(structureAbiOutputs([true, ["9"], "0xdead"], outputs)).toEqual({
      ok: true,
      info: { id: "9" },
      unnamedOutput2: "0xdead",
    });
  });

  it("maps a tuple[] output element-wise", () => {
    const outputs: AbiOutputParam[] = [
      {
        name: "items",
        type: "tuple[]",
        components: [
          { name: "a", type: "uint256" },
          { name: "b", type: "address" },
        ],
      },
    ];
    const value = [
      ["1", "0x1"],
      ["2", "0x2"],
    ];
    expect(structureAbiOutputs([value], outputs)).toEqual({
      items: [
        { a: "1", b: "0x1" },
        { a: "2", b: "0x2" },
      ],
    });
  });

  it("structures a nested tuple[][] without flattening dimensions", () => {
    const outputs: AbiOutputParam[] = [
      {
        name: "grid",
        type: "tuple[][]",
        components: [{ name: "a", type: "uint256" }],
      },
    ];
    const value = [[["1"], ["2"]], [["3"]]];
    expect(structureAbiOutputs([value], outputs)).toEqual({
      grid: [[{ a: "1" }, { a: "2" }], [{ a: "3" }]],
    });
  });

  it("passes primitive arrays through untouched", () => {
    const outputs: AbiOutputParam[] = [{ name: "amounts", type: "uint256[]" }];
    expect(structureAbiOutputs([["1", "2", "3"]], outputs)).toEqual({
      amounts: ["1", "2", "3"],
    });
  });
});
