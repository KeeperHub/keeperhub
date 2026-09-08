/**
 * KEEP-828: wallet route input schemas. The withdraw schema is the tightest
 * gate in the app (it guards a fund-moving endpoint), so it must reject bad
 * addresses, non-positive amounts, the fromMax/token conflict, and unknown
 * fields.
 */
import { describe, expect, it } from "vitest";
import { exportKeyVerifySchema, withdrawSchema } from "@/lib/schemas/wallet";

const VALID_ADDRESS = `0x${"a".repeat(40)}`;

describe("withdrawSchema", () => {
  it("accepts a valid native withdraw", () => {
    expect(
      withdrawSchema.safeParse({
        chainId: 1,
        recipient: VALID_ADDRESS,
        amount: "1.5",
      }).success
    ).toBe(true);
  });

  it("accepts fromMax native withdraw without an amount", () => {
    expect(
      withdrawSchema.safeParse({
        chainId: 1,
        recipient: VALID_ADDRESS,
        fromMax: true,
      }).success
    ).toBe(true);
  });

  it("accepts a numeric-string chainId", () => {
    expect(
      withdrawSchema.safeParse({
        chainId: "8453",
        recipient: VALID_ADDRESS,
        amount: "1",
      }).success
    ).toBe(true);
  });

  it("rejects an invalid recipient address", () => {
    expect(
      withdrawSchema.safeParse({
        chainId: 1,
        recipient: "not-an-address",
        amount: "1",
      }).success
    ).toBe(false);
  });

  it("rejects a missing amount when fromMax is not set", () => {
    expect(
      withdrawSchema.safeParse({ chainId: 1, recipient: VALID_ADDRESS }).success
    ).toBe(false);
  });

  it("rejects a non-positive amount", () => {
    expect(
      withdrawSchema.safeParse({
        chainId: 1,
        recipient: VALID_ADDRESS,
        amount: "0",
      }).success
    ).toBe(false);
  });

  it("rejects fromMax combined with a tokenAddress (native only)", () => {
    expect(
      withdrawSchema.safeParse({
        chainId: 1,
        recipient: VALID_ADDRESS,
        fromMax: true,
        tokenAddress: VALID_ADDRESS,
      }).success
    ).toBe(false);
  });

  it("rejects a non-numeric chainId", () => {
    expect(
      withdrawSchema.safeParse({
        chainId: "abc",
        recipient: VALID_ADDRESS,
        amount: "1",
      }).success
    ).toBe(false);
  });

  it("rejects unknown fields (strict)", () => {
    expect(
      withdrawSchema.safeParse({
        chainId: 1,
        recipient: VALID_ADDRESS,
        amount: "1",
        evil: true,
      }).success
    ).toBe(false);
  });
});

describe("exportKeyVerifySchema", () => {
  it("accepts an empty body (the OTP-mint first call)", () => {
    expect(exportKeyVerifySchema.safeParse({}).success).toBe(true);
  });

  it("accepts code plus emailOtp", () => {
    expect(
      exportKeyVerifySchema.safeParse({ code: "123456", emailOtp: "999999" })
        .success
    ).toBe(true);
  });

  it("rejects unknown fields (strict)", () => {
    expect(
      exportKeyVerifySchema.safeParse({ code: "123456", extra: 1 }).success
    ).toBe(false);
  });
});
