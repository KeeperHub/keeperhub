import { describe, expect, it } from "vitest";
import {
  EMPTY_CALLDATA,
  intentDigest,
  selectorOf,
} from "@/lib/policy/intent-digest";

const POOL = "0xA238dd80C259a72e81d7e4664a9801593F98d1c5";

describe("selectorOf", () => {
  it("reads the four-byte selector off calldata", () => {
    expect(selectorOf("0x617ba037000000000000000000000000aaaa")).toBe(
      "0x617ba037"
    );
  });

  it.each([[undefined], [null], ["0x"], [""]])(
    "reports empty calldata for %s",
    (data) => {
      expect(selectorOf(data)).toBe(EMPTY_CALLDATA);
    }
  );

  it("lowercases, so a mixed-case selector still matches a rule", () => {
    expect(selectorOf("0x617BA037aaaa")).toBe("0x617ba037");
  });
});

describe("intentDigest", () => {
  const base = {
    chainId: 8453,
    to: POOL,
    selector: "0x617ba037",
    valueWei: "0",
  };

  it("agrees across the two layers that compute it independently", () => {
    // The node knows the contract and selector before encoding; the signer
    // reads the same values off the transaction. Both must land on one digest
    // or the receipt never matches and the action is decided twice.
    const fromNode = intentDigest(base);
    const fromSigner = intentDigest({
      ...base,
      to: POOL.toLowerCase(),
      selector: "0x617BA037",
    });
    expect(fromSigner).toBe(fromNode);
  });

  it.each([
    ["a different chain", { chainId: 1 }],
    [
      "a different contract",
      { to: "0x0000000000000000000000000000000000000001" },
    ],
    ["a different function", { selector: "0xa415bcad" }],
    ["a different value", { valueWei: "1" }],
  ])("changes for %s", (_name, override) => {
    expect(intentDigest({ ...base, ...override })).not.toBe(intentDigest(base));
  });
});
