import { describe, expect, it } from "vitest";
import {
  arnStringMatches,
  buildContractCallArn,
  isValidAddress,
  parseArn,
} from "@/lib/policy";

/** The same contract, written the three ways people write it. */
const CHECKSUMMED = "0xA238dd80C259a72e81d7e4664a9801593F98d1c5";
const LOWER = CHECKSUMMED.toLowerCase();
const UPPER = `0x${CHECKSUMMED.slice(2).toUpperCase()}`;
const SPL = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

describe("EVM addresses", () => {
  it.each([[CHECKSUMMED], [LOWER], [UPPER]])("accepts %s", (address) => {
    expect(isValidAddress(address)).toBe(true);
  });

  it.each([[CHECKSUMMED], [LOWER], [UPPER]])(
    "normalises %s to one form",
    (address) => {
      // An author may write a checksummed address, a wallet may emit a
      // lowercase one, and an explorer may paste an uppercase one. All three
      // name the same contract, so all three have to compile to one identifier
      // or a rule would depend on how it was typed.
      const arn = buildContractCallArn({
        chainId: 8453,
        contractAddress: address,
        selector: null,
      });
      expect(arn).toContain(LOWER);
    }
  );

  it("matches a rule written in one case against a call seen in another", () => {
    const rule = buildContractCallArn({
      chainId: 8453,
      contractAddress: CHECKSUMMED,
      selector: "0x617ba037",
    });
    const seen = buildContractCallArn({
      chainId: 8453,
      contractAddress: LOWER,
      selector: "0x617BA037",
    });
    expect(arnStringMatches(rule, seen)).toBe(true);
  });
});

describe("base58 addresses", () => {
  it("accepts one", () => {
    expect(isValidAddress(SPL)).toBe(true);
  });

  it("keeps the case exactly, because case is part of the key", () => {
    // Base58 carries no checksum, so lowercasing does not fail: it decodes to
    // a different and still valid key.
    const arn = buildContractCallArn({
      chainId: 101,
      contractAddress: SPL,
      selector: null,
    });
    expect(arn).toContain(SPL);
  });

  it("does not match the same characters in another case", () => {
    const rule = buildContractCallArn({
      chainId: 101,
      contractAddress: SPL,
      selector: null,
    });
    const other = buildContractCallArn({
      chainId: 101,
      contractAddress: SPL.toLowerCase(),
      selector: null,
    });
    expect(arnStringMatches(rule, other)).toBe(false);
  });
});

describe("what the grammar refuses", () => {
  it.each([
    ["0x1234"],
    ["not-an-address"],
    ["0xZZ38dd80C259a72e81d7e4664a9801593F98d1c5"],
  ])("refuses %s", (value) => {
    expect(isValidAddress(value)).toBe(false);
  });

  it("still parses an identifier built from a valid address", () => {
    expect(parseArn(`kh:chain/8453/contract/${LOWER}/fn/*`).ok).toBe(true);
  });
});
