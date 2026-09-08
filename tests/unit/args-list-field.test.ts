import { beforeEach, describe, expect, it } from "vitest";

import {
  parseArgsListValue,
  parseFunctionInputs,
  serializeArgsList,
} from "@/components/workflow/config/args-list-field";

let idCounter = 0;
function nextId(): number {
  idCounter += 1;
  return idCounter;
}

function resetIds(): void {
  idCounter = 0;
}

const BALANCE_OF_ABI = JSON.stringify([
  {
    name: "balanceOf",
    type: "function",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "balance", type: "uint256" }],
  },
]);

const ALLOWANCE_ABI = JSON.stringify([
  {
    name: "allowance",
    type: "function",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
]);

const NO_PARAMS_ABI = JSON.stringify([
  {
    name: "totalSupply",
    type: "function",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
]);

const MIXED_ABI = JSON.stringify([
  {
    name: "balanceOf",
    type: "function",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "Transfer",
    type: "event",
    inputs: [{ name: "from", type: "address" }],
  },
]);

// ─── parseFunctionInputs ────────────────────────────────────────────────────

describe("parseFunctionInputs", () => {
  it("extracts single parameter from ABI", () => {
    const result = parseFunctionInputs(BALANCE_OF_ABI, "balanceOf");
    expect(result).toEqual([{ name: "account", type: "address" }]);
  });

  it("extracts multiple parameters from ABI", () => {
    const result = parseFunctionInputs(ALLOWANCE_ABI, "allowance");
    expect(result).toEqual([
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ]);
  });

  it("returns empty array for function with no parameters", () => {
    const result = parseFunctionInputs(NO_PARAMS_ABI, "totalSupply");
    expect(result).toEqual([]);
  });

  it("returns empty array when function not found", () => {
    const result = parseFunctionInputs(BALANCE_OF_ABI, "nonExistent");
    expect(result).toEqual([]);
  });

  it("ignores non-function entries (events)", () => {
    const result = parseFunctionInputs(MIXED_ABI, "Transfer");
    expect(result).toEqual([]);
  });

  it("finds correct function in mixed ABI", () => {
    const result = parseFunctionInputs(MIXED_ABI, "balanceOf");
    expect(result).toEqual([{ name: "account", type: "address" }]);
  });

  it("returns empty array for empty abiValue", () => {
    expect(parseFunctionInputs("", "balanceOf")).toEqual([]);
  });

  it("returns empty array for empty functionValue", () => {
    expect(parseFunctionInputs(BALANCE_OF_ABI, "")).toEqual([]);
  });

  it("returns empty array for invalid JSON", () => {
    expect(parseFunctionInputs("not json", "balanceOf")).toEqual([]);
  });

  it("returns empty array for non-array ABI", () => {
    expect(parseFunctionInputs('{"not": "array"}', "balanceOf")).toEqual([]);
  });

  it("defaults unnamed parameters to 'unnamed'", () => {
    const abi = JSON.stringify([
      {
        name: "test",
        type: "function",
        inputs: [{ name: "", type: "uint256" }],
      },
    ]);
    const result = parseFunctionInputs(abi, "test");
    expect(result).toEqual([{ name: "unnamed", type: "uint256" }]);
  });
});

// ─── parseArgsListValue ─────────────────────────────────────────────────────

describe("parseArgsListValue", () => {
  beforeEach(resetIds);

  it("returns one empty entry for empty value", () => {
    const result = parseArgsListValue("", 2, nextId);
    expect(result).toHaveLength(1);
    expect(result[0].values).toEqual(["", ""]);
  });

  it("parses valid JSON arg sets", () => {
    const result = parseArgsListValue('[["0xAddr1"], ["0xAddr2"]]', 1, nextId);
    expect(result).toHaveLength(2);
    expect(result[0].values).toEqual(["0xAddr1"]);
    expect(result[1].values).toEqual(["0xAddr2"]);
  });

  it("parses multi-param arg sets", () => {
    const result = parseArgsListValue(
      '[["0xOwner", "0xSpender"], ["0xOwner2", "0xSpender2"]]',
      2,
      nextId
    );
    expect(result).toHaveLength(2);
    expect(result[0].values).toEqual(["0xOwner", "0xSpender"]);
    expect(result[1].values).toEqual(["0xOwner2", "0xSpender2"]);
  });

  it("pads missing values with empty strings", () => {
    const result = parseArgsListValue('[["0xOnly"]]', 3, nextId);
    expect(result[0].values).toEqual(["0xOnly", "", ""]);
  });

  it("truncates extra values to paramCount", () => {
    const result = parseArgsListValue('[["a", "b", "c"]]', 2, nextId);
    expect(result[0].values).toEqual(["a", "b"]);
  });

  it("converts non-string values to strings", () => {
    const result = parseArgsListValue("[[42, true, null]]", 3, nextId);
    expect(result[0].values).toEqual(["42", "true", ""]);
  });

  it("handles non-array arg set entries", () => {
    const result = parseArgsListValue('["not-an-array"]', 1, nextId);
    expect(result[0].values).toEqual([""]);
  });

  it("returns empty entry for invalid JSON", () => {
    const result = parseArgsListValue("not json", 1, nextId);
    expect(result).toHaveLength(1);
    expect(result[0].values).toEqual([""]);
  });

  it("returns empty entry for empty array", () => {
    const result = parseArgsListValue("[]", 1, nextId);
    expect(result).toHaveLength(1);
    expect(result[0].values).toEqual([""]);
  });

  it("returns empty entry for non-array JSON", () => {
    const result = parseArgsListValue('{"not": "array"}', 1, nextId);
    expect(result).toHaveLength(1);
    expect(result[0].values).toEqual([""]);
  });

  it("assigns unique IDs to each entry", () => {
    const result = parseArgsListValue('[["a"], ["b"], ["c"]]', 1, nextId);
    const ids = result.map((e) => e.id);
    expect(new Set(ids).size).toBe(3);
  });

  it("handles zero paramCount", () => {
    const result = parseArgsListValue("[[], []]", 0, nextId);
    expect(result).toHaveLength(2);
    expect(result[0].values).toEqual([]);
    expect(result[1].values).toEqual([]);
  });
});

// ─── serializeArgsList ──────────────────────────────────────────────────────

describe("serializeArgsList", () => {
  it("serializes entries to JSON array of arrays", () => {
    const result = serializeArgsList([
      { id: 1, values: ["0xAddr1"] },
      { id: 2, values: ["0xAddr2"] },
    ]);
    expect(JSON.parse(result)).toEqual([["0xAddr1"], ["0xAddr2"]]);
  });

  it("serializes multi-param entries", () => {
    const result = serializeArgsList([
      { id: 1, values: ["0xOwner", "0xSpender"] },
    ]);
    expect(JSON.parse(result)).toEqual([["0xOwner", "0xSpender"]]);
  });

  it("filters out entries with all empty values", () => {
    const result = serializeArgsList([
      { id: 1, values: ["0xAddr1"] },
      { id: 2, values: ["", ""] },
      { id: 3, values: ["0xAddr2"] },
    ]);
    expect(JSON.parse(result)).toEqual([["0xAddr1"], ["0xAddr2"]]);
  });

  it("returns empty string when all entries are empty", () => {
    const result = serializeArgsList([
      { id: 1, values: [""] },
      { id: 2, values: ["", ""] },
    ]);
    expect(result).toBe("");
  });

  it("returns empty string for empty entries array", () => {
    expect(serializeArgsList([])).toBe("");
  });

  it("keeps entries with at least one non-empty value", () => {
    const result = serializeArgsList([{ id: 1, values: ["", "0xSpender"] }]);
    expect(JSON.parse(result)).toEqual([["", "0xSpender"]]);
  });

  it("preserves whitespace-only values as empty after filter", () => {
    const result = serializeArgsList([{ id: 1, values: ["  ", "   "] }]);
    expect(result).toBe("");
  });
});

// ─── Round-trip ─────────────────────────────────────────────────────────────

describe("args-list-field round-trip", () => {
  beforeEach(resetIds);

  it("parse -> serialize produces equivalent output", () => {
    const original = '[["0xAddr1"], ["0xAddr2"]]';
    const parsed = parseArgsListValue(original, 1, nextId);
    const serialized = serializeArgsList(parsed);
    expect(JSON.parse(serialized)).toEqual(JSON.parse(original));
  });

  it("multi-param round-trip preserves values", () => {
    const original = '[["0xOwner", "0xSpender"], ["0xOwner2", "0xSpender2"]]';
    const parsed = parseArgsListValue(original, 2, nextId);
    const serialized = serializeArgsList(parsed);
    expect(JSON.parse(serialized)).toEqual(JSON.parse(original));
  });

  it("round-trip with empty value produces empty string", () => {
    const parsed = parseArgsListValue("", 1, nextId);
    const serialized = serializeArgsList(parsed);
    expect(serialized).toBe("");
  });
});
