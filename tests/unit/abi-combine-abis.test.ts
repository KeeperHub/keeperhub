/**
 * combineAbis merges the facet ABIs of a Diamond proxy and deduplicates
 * functions by selector. The selector has to expand tuple parameters, or two
 * overloads that differ only inside a struct collide and the second is dropped
 * from the merged ABI at fetch time -- before any lookup could find it.
 *
 * Run with: pnpm vitest tests/unit/abi-combine-abis.test.ts
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { EXTERNAL_SERVICE: "external_service" },
  logUserError: vi.fn(),
}));

import { combineAbis } from "@/lib/abi/combine-abis";

type Entry = { type: string; name?: string; inputs?: unknown[] };

function functions(merged: string): string[] {
  return (JSON.parse(merged) as Entry[])
    .filter((e) => e.type === "function")
    .map((e) => `${e.name}/${JSON.stringify(e.inputs)}`);
}

const PERMIT_SINGLE = {
  type: "function",
  name: "permit",
  stateMutability: "nonpayable",
  inputs: [
    { name: "owner", type: "address" },
    {
      name: "single",
      type: "tuple",
      components: [
        { name: "token", type: "address" },
        { name: "amount", type: "uint160" },
      ],
    },
    { name: "signature", type: "bytes" },
  ],
  outputs: [],
};

const PERMIT_BATCH = {
  type: "function",
  name: "permit",
  stateMutability: "nonpayable",
  inputs: [
    { name: "owner", type: "address" },
    {
      name: "batch",
      type: "tuple",
      components: [
        { name: "spender", type: "address" },
        { name: "deadline", type: "uint256" },
      ],
    },
    { name: "signature", type: "bytes" },
  ],
  outputs: [],
};

const TRANSFER = {
  type: "function",
  name: "transfer",
  stateMutability: "nonpayable",
  inputs: [
    { name: "to", type: "address" },
    { name: "amount", type: "uint256" },
  ],
  outputs: [{ name: "", type: "bool" }],
};

const TRANSFER_EVENT = {
  type: "event",
  name: "Transfer",
  inputs: [
    { name: "from", type: "address", indexed: true },
    { name: "to", type: "address", indexed: true },
    { name: "value", type: "uint256", indexed: false },
  ],
  anonymous: false,
};

describe("combineAbis", () => {
  it("keeps two overloads that differ only inside a struct, within one facet", () => {
    const merged = combineAbis([JSON.stringify([PERMIT_SINGLE, PERMIT_BATCH])]);
    expect(functions(merged)).toHaveLength(2);
  });

  it("keeps two overloads that differ only inside a struct, across facets", () => {
    const merged = combineAbis([
      JSON.stringify([PERMIT_SINGLE]),
      JSON.stringify([PERMIT_BATCH]),
    ]);
    expect(functions(merged)).toHaveLength(2);
  });

  it("drops a genuine duplicate declared by a later facet", () => {
    const merged = combineAbis([
      JSON.stringify([TRANSFER]),
      JSON.stringify([TRANSFER, PERMIT_SINGLE]),
    ]);
    expect(functions(merged)).toEqual([
      `transfer/${JSON.stringify(TRANSFER.inputs)}`,
      `permit/${JSON.stringify(PERMIT_SINGLE.inputs)}`,
    ]);
  });

  it("preserves facet order and passes non-function entries through", () => {
    const merged = combineAbis([
      JSON.stringify([TRANSFER_EVENT, TRANSFER]),
      JSON.stringify([PERMIT_BATCH]),
    ]);
    const entries = JSON.parse(merged) as Entry[];
    expect(entries.map((e) => `${e.type}:${e.name}`)).toEqual([
      "event:Transfer",
      "function:transfer",
      "function:permit",
    ]);
  });

  it("keeps the healthy functions beside an entry that cannot be canonicalised", () => {
    const broken = {
      type: "function",
      name: "broken",
      inputs: [{ name: "p", type: "tuple", components: [{ name: "a" }] }],
      outputs: [],
    };
    const merged = combineAbis([
      JSON.stringify([TRANSFER, broken, PERMIT_SINGLE]),
    ]);
    const names = (JSON.parse(merged) as Entry[]).map((e) => e.name);
    expect(names).toEqual(["transfer", "broken", "permit"]);
  });

  it("does not deduplicate entries it cannot compute a selector for", () => {
    const broken = {
      type: "function",
      name: "broken",
      inputs: [{ name: "p", type: "tuple", components: [{ name: "a" }] }],
      outputs: [],
    };
    const merged = combineAbis([JSON.stringify([broken, broken])]);
    expect(functions(merged)).toHaveLength(2);
  });

  it("skips a facet that does not parse without affecting the others", () => {
    const merged = combineAbis([
      JSON.stringify([TRANSFER]),
      "{not json",
      JSON.stringify([PERMIT_BATCH]),
    ]);
    expect(functions(merged)).toHaveLength(2);
  });

  it("returns an empty array for no facets", () => {
    expect(combineAbis([])).toBe("[]");
  });
});
