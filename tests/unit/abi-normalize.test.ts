import { ethers } from "ethers";
import { describe, expect, it, vi } from "vitest";
import { normalizeAbiEntries } from "@/lib/abi/normalize";
import { type AbiItem, resolveAbiFunction } from "@/lib/abi/utils";

const HUMAN = "function transfer(address to, uint256 amount) returns (bool)";
const OBJECT = {
  type: "function",
  name: "burn",
  inputs: [{ name: "n", type: "uint256" }],
  outputs: [],
  stateMutability: "nonpayable",
};
const MALFORMED = { type: "function", name: "odd", inputs: "nope" };

describe("normalizeAbiEntries", () => {
  it("expands a human-readable fragment into the object ethers derives from it", () => {
    const [entry] = normalizeAbiEntries([HUMAN]) as AbiItem[];
    expect(entry).toMatchObject({
      type: "function",
      name: "transfer",
      inputs: [
        { type: "address", name: "to" },
        { type: "uint256", name: "amount" },
      ],
    });
    const resolution = resolveAbiFunction([entry], "transfer");
    expect(resolution).toMatchObject({
      status: "found",
      canonicalKey: "transfer(address,uint256)",
    });
  });

  it("passes object entries through unchanged, malformed ones included", () => {
    const normalized = normalizeAbiEntries([OBJECT, MALFORMED]);
    expect(normalized[0]).toBe(OBJECT);
    expect(normalized[1]).toBe(MALFORMED);
  });

  it("keeps order across mixed spellings", () => {
    const names = (normalizeAbiEntries([HUMAN, OBJECT]) as AbiItem[]).map(
      (e) => e.name
    );
    expect(names).toEqual(["transfer", "burn"]);
  });

  it("drops a string ethers cannot parse and keeps its neighbours, as ethers does", () => {
    const warn = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const abi = [HUMAN, "not a fragment at all", OBJECT];
    const normalized = normalizeAbiEntries(abi) as AbiItem[];
    expect(normalized.map((e) => e.name)).toEqual(["transfer", "burn"]);
    // Same functions ethers itself keeps from the unnormalized array.
    expect(
      new ethers.Interface(abi as ethers.InterfaceAbi).fragments.map((f) =>
        f.format("sighash")
      )
    ).toEqual(["transfer(address,uint256)", "burn(uint256)"]);
    warn.mockRestore();
  });
});
