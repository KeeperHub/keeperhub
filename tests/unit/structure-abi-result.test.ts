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

  describe("declared output names", () => {
    it("keys a single unnamed output by the declared name", () => {
      // The regression: a protocol declares an `outputs` override on a
      // function whose ABI output is unnamed. Without the declared name the
      // value comes back bare and the suggested template path finds nothing.
      const outputs: AbiOutputParam[] = [{ name: "", type: "bool" }];
      expect(
        structureAbiOutputs([true], outputs, ["approvalRequired"])
      ).toEqual({ approvalRequired: true });
    });

    it("keys unnamed outputs of a multi-output call by their declared names", () => {
      const outputs: AbiOutputParam[] = [
        { name: "", type: "uint256" },
        { name: "", type: "uint256" },
      ];
      expect(
        structureAbiOutputs(["1", "2"], outputs, ["value", "age"])
      ).toEqual({ value: "1", age: "2" });
    });

    it("lets the ABI name win over a declared name", () => {
      // The ABI is authoritative. A declared name that disagrees must not
      // rename a real output, or paths that work today would break.
      const outputs: AbiOutputParam[] = [{ name: "fee", type: "uint256" }];
      expect(structureAbiOutputs(["1"], outputs, ["cost"])).toEqual({
        fee: "1",
      });
    });

    it("falls back to unnamedOutput<index> where no name is declared", () => {
      const outputs: AbiOutputParam[] = [
        { name: "", type: "bool" },
        { name: "", type: "uint256" },
      ];
      expect(structureAbiOutputs([true, "7"], outputs, ["ok"])).toEqual({
        ok: true,
        unnamedOutput1: "7",
      });
    });

    it("ignores blank declared names rather than keying on an empty string", () => {
      const outputs: AbiOutputParam[] = [{ name: "", type: "uint256" }];
      expect(structureAbiOutputs(["1"], outputs, ["   "])).toBe("1");
    });

    it("structures a declared-name tuple's components as usual", () => {
      const outputs: AbiOutputParam[] = [
        {
          name: "",
          type: "tuple",
          components: [
            { name: "drawn", type: "uint256" },
            { name: "premium", type: "uint256" },
          ],
        },
      ];
      expect(structureAbiOutputs([["1", "2"]], outputs, ["debt"])).toEqual({
        debt: { drawn: "1", premium: "2" },
      });
    });
  });
});
