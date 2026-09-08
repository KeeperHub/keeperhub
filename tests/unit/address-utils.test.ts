import { describe, expect, it } from "vitest";

import {
  normalizeAddressForStorage,
  toChecksumAddress,
  truncateAddress,
} from "@/lib/address-utils";

describe("address-utils", () => {
  const lowercaseAddress = "0xae36bc35098e24bbaed3dee86ec4653eb88a71a9";
  const checksummedAddress = "0xae36bc35098E24bbaeD3deE86EC4653Eb88A71a9";

  describe("toChecksumAddress", () => {
    it("returns EIP-55 checksummed form for valid lowercase address", () => {
      expect(toChecksumAddress(lowercaseAddress)).toBe(checksummedAddress);
    });

    it("returns unchanged for valid checksummed address", () => {
      expect(toChecksumAddress(checksummedAddress)).toBe(checksummedAddress);
    });

    it("returns passthrough for invalid address (no throw)", () => {
      const invalid = "0xinvalid";
      expect(toChecksumAddress(invalid)).toBe(invalid);
    });

    it("returns passthrough for empty string", () => {
      expect(toChecksumAddress("")).toBe("");
    });

    it("returns passthrough for too-short hex", () => {
      const short = "0x1234";
      expect(toChecksumAddress(short)).toBe(short);
    });
  });

  describe("normalizeAddressForStorage", () => {
    it("returns lowercase for valid lowercase address", () => {
      expect(normalizeAddressForStorage(lowercaseAddress)).toBe(
        lowercaseAddress
      );
    });

    it("returns lowercase for valid checksummed address", () => {
      expect(normalizeAddressForStorage(checksummedAddress)).toBe(
        lowercaseAddress
      );
    });

    it("throws for invalid address", () => {
      expect(() => normalizeAddressForStorage("0xinvalid")).toThrow();
    });
  });

  describe("truncateAddress", () => {
    it("returns checksummed address when length <= maxLength", () => {
      const short = "0x1234";
      expect(truncateAddress(short, 10)).toBe(short);
      expect(truncateAddress(lowercaseAddress, 50)).toBe(checksummedAddress);
    });

    it("returns truncated checksummed format for long address", () => {
      const result = truncateAddress(lowercaseAddress, 10);
      expect(result).toBe("0xae36...71a9");
      expect(result.startsWith("0x")).toBe(true);
      expect(result).toContain("...");
      expect(result.endsWith("71a9")).toBe(true);
    });

    it("uses default maxLength 10", () => {
      const result = truncateAddress(lowercaseAddress);
      expect(result).toBe("0xae36...71a9");
    });

    it("returns full checksummed when maxLength >= address length", () => {
      const result = truncateAddress(lowercaseAddress, 50);
      expect(result).toBe(checksummedAddress);
    });

    it("handles invalid address by passing through then truncating", () => {
      const invalid = "0xnotavalidaddressbutlongenough";
      expect(truncateAddress(invalid, 10)).toBe("0xnota...ough");
    });
  });
});
