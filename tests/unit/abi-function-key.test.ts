import { ethers } from "ethers";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { getAbiFunctionKey } from "@/lib/abi/function-key";
import {
  type AbiItem,
  findAbiFunction,
  resolveAbiFunction,
} from "@/lib/abi/utils";

const TOKEN = "0x4200000000000000000000000000000000000006";

const SWAP_ABI: AbiItem[] = [
  {
    type: "function",
    name: "swap",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
  },
  {
    type: "function",
    name: "swap",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "token", type: "address" },
          { name: "amount", type: "uint256" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
  },
];

function keyFor(abi: AbiItem[], storedKey: string): string {
  const resolution = resolveAbiFunction(abi, storedKey);
  if (resolution.status !== "found") {
    throw new Error(`expected ${storedKey} to resolve, got ${resolution.status}`);
  }
  return getAbiFunctionKey(abi, storedKey, resolution.entry);
}

describe("getAbiFunctionKey", () => {
  it("returns the plain name when the function is not overloaded", () => {
    expect(keyFor(SWAP_ABI, "transfer")).toBe("transfer");
  });

  it("expands a tuple parameter into its component types", () => {
    expect(keyFor(SWAP_ABI, "swap((address,uint256))")).toBe(
      "swap((address,uint256))"
    );
  });

  it("qualifies a bare name that is overloaded", () => {
    const entry = findAbiFunction(SWAP_ABI, "swap");
    if (!entry) {
      throw new Error("expected swap to resolve");
    }
    expect(getAbiFunctionKey(SWAP_ABI, "swap", entry)).toBe("swap(uint256)");
  });

  it("rebuilds the key when the stored value is already qualified", () => {
    // Overloads are counted by the entry's own name. Counting by the passed-in
    // string would match no ABI entry, and a legacy key would be handed back
    // unchanged -- which is the shape that fails to encode.
    expect(keyFor(SWAP_ABI, "swap(tuple)")).toBe("swap((address,uint256))");
  });

  it("leaves a non-tuple overload key unchanged", () => {
    expect(keyFor(SWAP_ABI, "swap(uint256)")).toBe("swap(uint256)");
  });
});

describe("resolve then encode", () => {
  // The seam the two halves meet at: a key that resolves is not necessarily a
  // key ethers accepts. Every case below runs all the way to call data.
  const iface = new ethers.Interface(SWAP_ABI as ethers.InterfaceAbi);
  const tupleArgs = [{ token: TOKEN, amount: 1n }];

  it("encodes the tuple overload from its canonical key", () => {
    const data = iface.encodeFunctionData(
      keyFor(SWAP_ABI, "swap((address,uint256))"),
      tupleArgs
    );
    expect(data.slice(0, 10)).toBe("0xc546f7f6");
  });

  it("encodes the tuple overload from a stored legacy key", () => {
    const data = iface.encodeFunctionData(
      keyFor(SWAP_ABI, "swap(tuple)"),
      tupleArgs
    );
    expect(data.slice(0, 10)).toBe("0xc546f7f6");
  });

  it("encodes the scalar overload of the same name", () => {
    const data = iface.encodeFunctionData(keyFor(SWAP_ABI, "swap(uint256)"), [
      1n,
    ]);
    expect(data.slice(0, 10)).toBe("0x94b918de");
  });

  it("encodes an unambiguous request-supplied legacy key", () => {
    // API and MCP callers send the key themselves, so both spellings have to
    // survive resolution and reach the encoder in a form ethers accepts.
    const resolution = resolveAbiFunction(SWAP_ABI, "swap(tuple)");
    if (resolution.status !== "found") {
      throw new Error("expected the legacy key to resolve");
    }
    expect(() =>
      iface.encodeFunctionData(resolution.canonicalKey, tupleArgs)
    ).not.toThrow();
  });
});
