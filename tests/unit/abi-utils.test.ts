import { describe, expect, it } from "vitest";

import {
  type AbiItem,
  computeSelector,
  findAbiFunction,
} from "@/lib/abi/utils";

const SELECTOR_PATTERN = /^0x[\da-f]{8}$/;

describe("computeSelector", () => {
  it("returns correct 4-byte selector for transfer(address,uint256)", () => {
    expect(computeSelector("transfer", ["address", "uint256"])).toBe(
      "0xa9059cbb"
    );
  });

  it("returns correct 4-byte selector for approve(address,uint256)", () => {
    expect(computeSelector("approve", ["address", "uint256"])).toBe(
      "0x095ea7b3"
    );
  });

  it("returns correct 4-byte selector for balanceOf(address)", () => {
    expect(computeSelector("balanceOf", ["address"])).toBe("0x70a08231");
  });

  it("returns correct selector for no-arg function", () => {
    expect(computeSelector("totalSupply", [])).toBe("0x18160ddd");
  });

  it("returns a 10-character hex string (0x + 8 hex digits)", () => {
    const result = computeSelector("foo", ["uint256"]);
    expect(result).toMatch(SELECTOR_PATTERN);
  });

  it("expands tuple inputs to canonical component types", () => {
    const inputs = [
      {
        type: "tuple",
        components: [
          { name: "dstEid", type: "uint32" },
          { name: "to", type: "bytes32" },
          { name: "amountLD", type: "uint256" },
          { name: "minAmountLD", type: "uint256" },
          { name: "extraOptions", type: "bytes" },
          { name: "composeMsg", type: "bytes" },
          { name: "oftCmd", type: "bytes" },
        ],
      },
      {
        type: "tuple",
        components: [
          { name: "nativeFee", type: "uint256" },
          { name: "lzTokenFee", type: "uint256" },
        ],
      },
      { type: "address" },
    ];
    // send((uint32,bytes32,uint256,uint256,bytes,bytes,bytes),(uint256,uint256),address)
    expect(computeSelector("send", inputs)).toBe("0xc7c7f5b3");
  });

  it("handles tuple[] arrays correctly", () => {
    const inputs = [
      {
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "value", type: "uint256" },
        ],
      },
    ];
    // execute((address,uint256)[])
    const result = computeSelector("execute", inputs);
    expect(result).toMatch(SELECTOR_PATTERN);
  });

  it("handles nested tuples", () => {
    const inputs = [
      {
        type: "tuple",
        components: [
          { name: "id", type: "uint256" },
          {
            name: "inner",
            type: "tuple",
            components: [
              { name: "a", type: "address" },
              { name: "b", type: "uint256" },
            ],
          },
        ],
      },
    ];
    // fn((uint256,(address,uint256)))
    const result = computeSelector("fn", inputs);
    expect(result).toMatch(SELECTOR_PATTERN);
  });

  it("mixes string types and ABI input objects", () => {
    const inputs = [
      "address",
      {
        type: "tuple",
        components: [
          { name: "a", type: "uint256" },
          { name: "b", type: "uint256" },
        ],
      },
    ];
    const result = computeSelector("mixed", inputs);
    expect(result).toMatch(SELECTOR_PATTERN);
  });
});

const OVERLOADED_ABI: AbiItem[] = [
  {
    type: "function",
    name: "send",
    stateMutability: "payable",
    inputs: [
      {
        type: "tuple",
        name: "_sendParam",
        components: [
          { name: "dstEid", type: "uint32" },
          { name: "to", type: "bytes32" },
        ],
      },
      { type: "address", name: "_refundAddress" },
    ],
  },
  {
    type: "function",
    name: "send",
    stateMutability: "nonpayable",
    inputs: [
      { type: "address", name: "_to" },
      { type: "uint256", name: "_amount" },
    ],
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { type: "address", name: "to" },
      { type: "uint256", name: "amount" },
    ],
  },
];

describe("findAbiFunction", () => {
  it("finds a function by plain name when unambiguous", () => {
    const result = findAbiFunction(OVERLOADED_ABI, "transfer");
    expect(result).toBeDefined();
    expect(result?.name).toBe("transfer");
  });

  it("returns first match for plain name on overloaded functions", () => {
    const result = findAbiFunction(OVERLOADED_ABI, "send");
    expect(result).toBeDefined();
    expect(result?.name).toBe("send");
    expect(result?.stateMutability).toBe("payable");
  });

  it("finds the correct overload by qualified signature", () => {
    const result = findAbiFunction(OVERLOADED_ABI, "send(address,uint256)");
    expect(result).toBeDefined();
    expect(result?.stateMutability).toBe("nonpayable");
    expect(result?.inputs).toHaveLength(2);
  });

  it("finds the other overload by qualified signature", () => {
    const result = findAbiFunction(OVERLOADED_ABI, "send(tuple,address)");
    expect(result).toBeDefined();
    expect(result?.stateMutability).toBe("payable");
  });

  it("returns undefined for non-existent function", () => {
    expect(findAbiFunction(OVERLOADED_ABI, "nonexistent")).toBeUndefined();
  });

  it("returns undefined for qualified signature with wrong types", () => {
    expect(
      findAbiFunction(OVERLOADED_ABI, "send(uint256,uint256)")
    ).toBeUndefined();
  });

  it("returns undefined for qualified signature with wrong arity", () => {
    expect(findAbiFunction(OVERLOADED_ABI, "send(address)")).toBeUndefined();
  });

  it("handles empty ABI array", () => {
    expect(findAbiFunction([], "transfer")).toBeUndefined();
  });

  it("ignores non-function entries", () => {
    const abi: AbiItem[] = [
      { type: "event", name: "Transfer" },
      {
        type: "function",
        name: "Transfer",
        inputs: [{ type: "address", name: "to" }],
      },
    ];
    const result = findAbiFunction(abi, "Transfer");
    expect(result).toBeDefined();
    expect(result?.type).toBe("function");
  });
});
