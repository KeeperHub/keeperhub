import { describe, expect, it } from "vitest";

import { getReadContractOutputFields } from "@/lib/workflow/editor/action-output-fields";

function fieldNames(abi: unknown, fn: string): string[] {
  return getReadContractOutputFields(JSON.stringify(abi), fn).map(
    (f) => f.field
  );
}

describe("getReadContractOutputFields", () => {
  it("returns default fields when abi/function are missing", () => {
    const fields = getReadContractOutputFields(undefined, undefined).map(
      (f) => f.field
    );
    expect(fields).toEqual(["success", "result", "addressLink", "error"]);
  });

  it("surfaces result.<name> for a single named scalar output", () => {
    const abi = [
      {
        name: "balanceOf",
        type: "function",
        inputs: [],
        outputs: [{ name: "balance", type: "uint256" }],
      },
    ];
    expect(fieldNames(abi, "balanceOf")).toContain("result.balance");
  });

  it("expands nested tuple components for a single unnamed tuple output", () => {
    const abi = [
      {
        name: "getReserveData",
        type: "function",
        inputs: [],
        outputs: [
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
            ],
          },
        ],
      },
    ];
    const names = fieldNames(abi, "getReserveData");
    expect(names).toContain("result.configuration");
    expect(names).toContain("result.configuration.data");
    expect(names).toContain("result.liquidityIndex");
  });

  it("expands one level into a named tuple within a multi-output function", () => {
    const abi = [
      {
        name: "f",
        type: "function",
        inputs: [],
        outputs: [
          { name: "ok", type: "bool" },
          {
            name: "info",
            type: "tuple",
            components: [{ name: "id", type: "uint256" }],
          },
        ],
      },
    ];
    const names = fieldNames(abi, "f");
    expect(names).toContain("result.ok");
    expect(names).toContain("result.info");
    expect(names).toContain("result.info.id");
  });

  it("does not expand elements of a tuple[] output", () => {
    const abi = [
      {
        name: "f",
        type: "function",
        inputs: [],
        outputs: [
          {
            name: "items",
            type: "tuple[]",
            components: [{ name: "a", type: "uint256" }],
          },
        ],
      },
    ];
    const names = fieldNames(abi, "f");
    expect(names).toContain("result.items");
    expect(names).not.toContain("result.items.a");
  });
});
