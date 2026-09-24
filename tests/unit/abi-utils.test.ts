import { ethers } from "ethers";
import { describe, expect, it } from "vitest";
import {
  type AbiItem,
  canonicalType,
  computeSelector,
  describeAmbiguousKey,
  findAbiFunction,
  resolveAbiFunction,
} from "@/lib/abi/utils";
import { TUPLE_SHAPES } from "../fixtures/abi-tuple-shapes";

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

  it("finds the tuple overload by canonical signature", () => {
    const result = findAbiFunction(
      OVERLOADED_ABI,
      "send((uint32,bytes32),address)"
    );
    expect(result).toBeDefined();
    expect(result?.stateMutability).toBe("payable");
  });

  it("still finds the tuple overload by its legacy raw signature", () => {
    // Keys stored before tuples were expanded spell a struct as "tuple". They
    // stay valid wherever they identify one overload, so saved workflows and
    // external API callers keep working.
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

const COLLIDING_ABI: AbiItem[] = [
  {
    type: "function",
    name: "permit",
    stateMutability: "nonpayable",
    inputs: [
      { type: "address", name: "owner" },
      {
        type: "tuple",
        name: "permitSingle",
        components: [
          { name: "token", type: "address" },
          { name: "amount", type: "uint160" },
        ],
      },
      { type: "bytes", name: "signature" },
    ],
  },
  {
    type: "function",
    name: "permit",
    stateMutability: "nonpayable",
    inputs: [
      { type: "address", name: "owner" },
      {
        type: "tuple",
        name: "permitBatch",
        components: [
          { name: "spender", type: "address" },
          { name: "deadline", type: "uint256" },
        ],
      },
      { type: "bytes", name: "signature" },
    ],
  },
];

describe("canonicalType", () => {
  it("expands a tuple into its component types", () => {
    expect(
      canonicalType({
        type: "tuple",
        components: [
          { name: "a", type: "uint32" },
          { name: "b", type: "bytes32" },
        ],
      })
    ).toBe("(uint32,bytes32)");
  });

  it("keeps the array suffix on a tuple array", () => {
    expect(
      canonicalType({
        type: "tuple[]",
        components: [{ name: "a", type: "uint256" }],
      })
    ).toBe("(uint256)[]");
  });

  it('throws on a tuple with no components rather than returning the literal "tuple"', () => {
    // The one malformed shape that used to produce a wrong answer silently:
    // "tuple" is exactly the spelling ethers rejects, and it would otherwise
    // flow into a stored key, a selector and a canonical signature.
    expect(() => canonicalType({ type: "tuple" })).toThrow();
    expect(() => canonicalType({ type: "tuple[]" })).toThrow();
    expect(() =>
      canonicalType({
        type: "tuple",
        components: { a: "uint256" } as unknown as AbiItem["inputs"],
      })
    ).toThrow();
  });

  it("throws on an input with no type rather than fabricating a signature", () => {
    expect(() =>
      canonicalType({ components: [] } as unknown as { type: string })
    ).toThrow();
  });
});

describe("computeSelector on overloads that differ only inside a struct", () => {
  // The Diamond facet merge in app/api/web3/fetch-abi dedupes on this selector.
  // Raw ABI types render both structs as the literal "tuple", so the two
  // functions would collide and one would be dropped from the merged ABI.
  it("gives two tuple overloads distinct selectors", () => {
    const first = computeSelector("permit", COLLIDING_ABI[0].inputs ?? []);
    const second = computeSelector("permit", COLLIDING_ABI[1].inputs ?? []);
    expect(first).not.toBe(second);
  });

  it("collides when the signature is built from raw types instead", () => {
    const rawSignature = (item: AbiItem) =>
      `${item.name}(${(item.inputs ?? []).map((i) => i.type).join(",")})`;
    expect(rawSignature(COLLIDING_ABI[0])).toBe(rawSignature(COLLIDING_ABI[1]));
  });
});

describe("resolveAbiFunction", () => {
  it("reports a canonical key as found", () => {
    const result = resolveAbiFunction(
      OVERLOADED_ABI,
      "send((uint32,bytes32),address)"
    );
    expect(result.status).toBe("found");
  });

  it("returns the canonical key for a legacy raw key", () => {
    const result = resolveAbiFunction(OVERLOADED_ABI, "send(tuple,address)");
    expect(result).toMatchObject({
      status: "found",
      canonicalKey: "send((uint32,bytes32),address)",
    });
  });

  it("reports a legacy key that two overloads share as ambiguous", () => {
    const result = resolveAbiFunction(
      COLLIDING_ABI,
      "permit(address,tuple,bytes)"
    );
    expect(result.status).toBe("ambiguous");
    if (result.status === "ambiguous") {
      expect(result.candidates).toHaveLength(2);
    }
  });

  it("resolves each colliding overload by its own canonical key", () => {
    const single = resolveAbiFunction(
      COLLIDING_ABI,
      "permit(address,(address,uint160),bytes)"
    );
    const batch = resolveAbiFunction(
      COLLIDING_ABI,
      "permit(address,(address,uint256),bytes)"
    );
    expect(single.status).toBe("found");
    expect(batch.status).toBe("found");
    if (single.status === "found" && batch.status === "found") {
      expect(single.entry).not.toBe(batch.entry);
    }
  });

  it("reports a bare overloaded name as ambiguous while the UI helper stays total", () => {
    expect(resolveAbiFunction(OVERLOADED_ABI, "send").status).toBe("ambiguous");
    expect(findAbiFunction(OVERLOADED_ABI, "send")).toBe(OVERLOADED_ABI[0]);
  });

  it("reports an unknown key as not found", () => {
    expect(resolveAbiFunction(OVERLOADED_ABI, "missing(uint256)")).toEqual({
      status: "not_found",
    });
  });

  it("finds a healthy function next to an entry that cannot be canonicalised", () => {
    const abi = [
      {
        type: "function",
        name: "broken",
        inputs: [{ name: "a" }],
      },
      {
        type: "function",
        name: "broken",
        inputs: [{ name: "b", type: "uint256" }],
      },
    ] as unknown as AbiItem[];
    const result = resolveAbiFunction(abi, "broken(uint256)");
    expect(result.status).toBe("found");
  });

  it("does not match a corrupt entry against a stringified key", () => {
    const abi = [
      { type: "function", name: "broken", inputs: [{ name: "a" }] },
    ] as unknown as AbiItem[];
    expect(resolveAbiFunction(abi, "broken(undefined)")).toEqual({
      status: "not_found",
    });
  });

  it("does not report a tuple overload with no components as a canonical match", () => {
    const abi: AbiItem[] = [
      {
        type: "function",
        name: "send",
        stateMutability: "payable",
        inputs: [
          { name: "p", type: "tuple" },
          { name: "r", type: "address" },
        ],
      },
      {
        type: "function",
        name: "send",
        stateMutability: "nonpayable",
        inputs: [
          { name: "to", type: "address" },
          { name: "amount", type: "uint256" },
        ],
      },
    ];
    // The legacy spelling still identifies the entry, so it resolves -- but
    // the key it hands back must not be presented as a canonical signature,
    // because no encodable one exists for an entry like this.
    const result = resolveAbiFunction(abi, "send(tuple,address)");
    expect(result.status).toBe("found");
    if (result.status === "found") {
      expect(result.entry.stateMutability).toBe("payable");
      expect(result.canonicalKey).toBe("send(tuple,address)");
    }
    expect(resolveAbiFunction(abi, "send(address,uint256)").status).toBe(
      "found"
    );
  });

  it("tolerates components that are not an array", () => {
    const abi = [
      {
        type: "function",
        name: "weird",
        inputs: [{ name: "p", type: "tuple", components: { a: "uint256" } }],
      },
    ] as unknown as AbiItem[];
    expect(() => resolveAbiFunction(abi, "weird(tuple)")).not.toThrow();
    expect(resolveAbiFunction(abi, "weird(tuple)").status).toBe("found");
  });
});

describe("resolveAbiFunction on duplicated entries", () => {
  // Merged facet ABIs and some explorer responses list one function twice.
  // Repeats of the same signature are one function, not overloads.
  const DUPLICATED_SCALAR: AbiItem[] = [
    {
      type: "function",
      name: "f",
      stateMutability: "view",
      inputs: [{ name: "x", type: "uint256" }],
    },
    {
      type: "function",
      name: "f",
      stateMutability: "view",
      inputs: [{ name: "x", type: "uint256" }],
    },
  ];

  const DUPLICATED_TUPLE: AbiItem[] = [
    {
      type: "function",
      name: "f",
      stateMutability: "view",
      inputs: [
        {
          name: "p",
          type: "tuple",
          components: [{ name: "a", type: "address" }],
        },
      ],
    },
    {
      type: "function",
      name: "f",
      stateMutability: "view",
      inputs: [
        {
          name: "p",
          type: "tuple",
          components: [{ name: "a", type: "address" }],
        },
      ],
    },
  ];

  it("resolves a scalar function that is listed twice", () => {
    expect(resolveAbiFunction(DUPLICATED_SCALAR, "f(uint256)").status).toBe(
      "found"
    );
    expect(findAbiFunction(DUPLICATED_SCALAR, "f(uint256)")).toBeDefined();
  });

  it("resolves a tuple function that is listed twice by its canonical key", () => {
    expect(resolveAbiFunction(DUPLICATED_TUPLE, "f((address))").status).toBe(
      "found"
    );
  });

  it("resolves a tuple function that is listed twice by its legacy key", () => {
    expect(resolveAbiFunction(DUPLICATED_TUPLE, "f(tuple)").status).toBe(
      "found"
    );
  });

  it("reports ambiguity only across distinct overloads, listing each once", () => {
    const abi: AbiItem[] = [...DUPLICATED_TUPLE, ...COLLIDING_ABI];
    const tuple = resolveAbiFunction(abi, "f(tuple)");
    expect(tuple.status).toBe("found");

    const permit = resolveAbiFunction(
      [...COLLIDING_ABI, COLLIDING_ABI[0]],
      "permit(address,tuple,bytes)"
    );
    expect(permit.status).toBe("ambiguous");
    if (permit.status === "ambiguous") {
      expect(permit.candidates).toHaveLength(2);
    }
  });
});

describe("describeAmbiguousKey", () => {
  it("names the canonical signatures to choose between", () => {
    const result = resolveAbiFunction(
      COLLIDING_ABI,
      "permit(address,tuple,bytes)"
    );
    if (result.status !== "ambiguous") {
      throw new Error("expected an ambiguous resolution");
    }
    const message = describeAmbiguousKey(
      "permit(address,tuple,bytes)",
      result.candidates
    );
    expect(message).toContain("permit(address,(address,uint160),bytes)");
    expect(message).toContain("permit(address,(address,uint256),bytes)");
  });
});

describe("canonical tuple shapes against ethers", () => {
  it.each(TUPLE_SHAPES)("$label", ({ input, canonical }) => {
    expect(canonicalType(input)).toBe(canonical);
    const fragment = ethers.FunctionFragment.from({
      type: "function",
      name: "f",
      inputs: [input],
    });
    expect(fragment.format("sighash")).toBe(`f(${canonical})`);
    expect(computeSelector("f", [input])).toBe(fragment.selector);
  });

  it("combines a tuple and a scalar in one selector", () => {
    const inputs = [
      TUPLE_SHAPES[0].input,
      { name: "recipient", type: "address" },
    ];
    const fragment = ethers.FunctionFragment.from({
      type: "function",
      name: "send",
      inputs,
    });
    expect(fragment.format("sighash")).toBe("send((uint32,bytes32),address)");
    expect(computeSelector("send", inputs)).toBe(fragment.selector);
  });
});
