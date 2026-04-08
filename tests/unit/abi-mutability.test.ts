import { describe, expect, it } from "vitest";

import { deriveStateMutability } from "@/lib/web3/abi-mutability";

const PAYABLE_DEPOSIT = JSON.stringify([
  {
    type: "function",
    name: "deposit",
    inputs: [],
    outputs: [],
    stateMutability: "payable",
  },
]);

const NONPAYABLE_TRANSFER = JSON.stringify([
  {
    type: "function",
    name: "transfer",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
    stateMutability: "nonpayable",
  },
]);

const VIEW_BALANCE_OF = JSON.stringify([
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
]);

// Mixed ABI with events, errors, and a constructor alongside functions.
// Exercises the narrowing around items that lack a name or are not
// of type "function".
const MIXED_ABI = JSON.stringify([
  { type: "constructor", inputs: [], stateMutability: "nonpayable" },
  {
    type: "event",
    name: "Transfer",
    inputs: [],
    anonymous: false,
  },
  { type: "error", name: "Unauthorized", inputs: [] },
  {
    type: "function",
    name: "deposit",
    inputs: [],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "withdraw",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
]);

describe("deriveStateMutability", () => {
  it("returns 'payable' for a payable function", () => {
    expect(deriveStateMutability(PAYABLE_DEPOSIT, "deposit")).toBe("payable");
  });

  it("returns 'nonpayable' for a nonpayable function", () => {
    expect(deriveStateMutability(NONPAYABLE_TRANSFER, "transfer")).toBe(
      "nonpayable"
    );
  });

  it("returns 'view' for a view function", () => {
    expect(deriveStateMutability(VIEW_BALANCE_OF, "balanceOf")).toBe("view");
  });

  it("locates the right function in a mixed ABI with events/errors/constructor", () => {
    expect(deriveStateMutability(MIXED_ABI, "deposit")).toBe("payable");
    expect(deriveStateMutability(MIXED_ABI, "withdraw")).toBe("nonpayable");
  });

  it("fails closed to 'nonpayable' when the function is not in the ABI", () => {
    expect(deriveStateMutability(PAYABLE_DEPOSIT, "doesNotExist")).toBe(
      "nonpayable"
    );
  });

  it("fails closed to 'nonpayable' on invalid JSON", () => {
    expect(deriveStateMutability("{not json", "deposit")).toBe("nonpayable");
  });

  it("fails closed to 'nonpayable' when the ABI is not a JSON array", () => {
    expect(
      deriveStateMutability(JSON.stringify({ foo: "bar" }), "deposit")
    ).toBe("nonpayable");
  });

  it("fails closed to 'nonpayable' on an empty string", () => {
    expect(deriveStateMutability("", "deposit")).toBe("nonpayable");
  });

  it("fails closed when stateMutability field is missing", () => {
    const abi = JSON.stringify([
      { type: "function", name: "legacy", inputs: [], outputs: [] },
    ]);
    expect(deriveStateMutability(abi, "legacy")).toBe("nonpayable");
  });

  it("does not match an event with the same name as a function", () => {
    const abi = JSON.stringify([
      {
        type: "event",
        name: "deposit",
        inputs: [],
        anonymous: false,
      },
    ]);
    expect(deriveStateMutability(abi, "deposit")).toBe("nonpayable");
  });

  it("tolerates null items in the ABI array", () => {
    const abi = JSON.stringify([
      null,
      {
        type: "function",
        name: "deposit",
        inputs: [],
        outputs: [],
        stateMutability: "payable",
      },
    ]);
    expect(deriveStateMutability(abi, "deposit")).toBe("payable");
  });
});
