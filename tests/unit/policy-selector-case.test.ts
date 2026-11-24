import { describe, expect, it } from "vitest";
import {
  arnStringMatches,
  buildContractCallArn,
  isValidSelector,
  parseArn,
} from "@/lib/policy";
import { selectorOf } from "@/lib/policy/intent-digest";

const CONTRACT = "0xa238dd80c259a72e81d7e4664a9801593f98d1c5";
const LOWER = "0x617ba037";
const UPPER = "0x617BA037";

describe("selectors", () => {
  it.each([[LOWER], [UPPER]])("normalises %s to one form", (selector) => {
    // A selector is hex, so case is presentation. Both forms name the same
    // four bytes and have to compile to one identifier.
    expect(
      buildContractCallArn({
        chainId: 8453,
        contractAddress: CONTRACT,
        selector,
      })
    ).toContain(LOWER);
  });

  it("matches a rule written in one case against a call seen in another", () => {
    const rule = buildContractCallArn({
      chainId: 8453,
      contractAddress: CONTRACT,
      selector: UPPER,
    });
    const seen = buildContractCallArn({
      chainId: 8453,
      contractAddress: CONTRACT,
      selector: LOWER,
    });
    expect(arnStringMatches(rule, seen)).toBe(true);
  });

  it("reads a selector off calldata in either case", () => {
    expect(selectorOf(`${UPPER}0000`)).toBe(LOWER);
  });

  it("accepts a selector in either case", () => {
    expect(isValidSelector(LOWER)).toBe(true);
    // Rejecting the uppercase form while the grammar happily lowercases it
    // would refuse an identifier the parser accepts.
    expect(isValidSelector(UPPER)).toBe(true);
  });

  it("accepts the empty-calldata sentinel", () => {
    // A native transfer has no selector, and leaving that case undefined is a
    // gap rather than a default.
    expect(isValidSelector("none")).toBe(true);
    expect(
      buildContractCallArn({
        chainId: 8453,
        contractAddress: CONTRACT,
        selector: null,
      })
    ).toContain("/fn/none");
  });

  it.each([["0x617ba03"], ["0x617ba0377"], ["617ba037"], ["0xZZ7ba037"]])(
    "refuses %s",
    (value) => {
      expect(isValidSelector(value)).toBe(false);
    }
  );

  it("still parses an identifier carrying an uppercase selector", () => {
    const parsed = parseArn(`kh:chain/8453/contract/${CONTRACT}/fn/${UPPER}`);
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.arn.value).toContain(LOWER);
  });
});
