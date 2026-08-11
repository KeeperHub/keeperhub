import { describe, expect, it } from "vitest";
import {
  extractMppPayerAddress,
  hashMppCredential,
} from "@/lib/payments/mpp/server";

const HEX_SHA256_RE = /^[a-f0-9]{64}$/;

describe("extractMppPayerAddress", () => {
  it("extracts address from did:pkh DID source", () => {
    const did =
      "did:pkh:eip155:4217:0xAbCdEf1234567890AbCdEf1234567890AbCdEf12";
    expect(extractMppPayerAddress(did)).toBe(
      "0xAbCdEf1234567890AbCdEf1234567890AbCdEf12"
    );
  });

  it("returns null for null input", () => {
    expect(extractMppPayerAddress(null)).toBeNull();
  });

  it("returns null for malformed DID", () => {
    expect(extractMppPayerAddress("not-a-did")).toBeNull();
  });

  it("returns the full string if no colon separators", () => {
    expect(extractMppPayerAddress("0xSomeAddress")).toBe("0xSomeAddress");
  });
});

describe("hashMppCredential", () => {
  it("returns a hex SHA-256 hash", () => {
    const hash = hashMppCredential("Payment eyJjaGFsbGVuZ2UiOnt9fQ");
    expect(hash).toMatch(HEX_SHA256_RE);
  });

  it("is deterministic", () => {
    const a = hashMppCredential("Payment abc123");
    const b = hashMppCredential("Payment abc123");
    expect(a).toBe(b);
  });

  it("produces different hashes for different inputs", () => {
    const a = hashMppCredential("Payment abc");
    const b = hashMppCredential("Payment xyz");
    expect(a).not.toBe(b);
  });
});
