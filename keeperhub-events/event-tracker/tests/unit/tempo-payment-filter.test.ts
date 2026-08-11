import { describe, expect, it } from "vitest";
import { paymentEventMatches } from "../../src/listener/event-listener";

const TO = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
// "INV-1042" utf8, right-padded into a bytes32 (Solidity bytes32-string form).
const MEMO_INV1042 = `0x494e562d31303432${"0".repeat(48)}`;
const HASH = `0x${"ab".repeat(32)}`;

describe("paymentEventMatches", () => {
  it("forwards everything when no filter is set", () => {
    expect(paymentEventMatches({ to: TO, memo: MEMO_INV1042 })).toBe(true);
    expect(paymentEventMatches({ to: undefined, memo: undefined })).toBe(true);
  });

  it("matches the recipient case-insensitively", () => {
    expect(
      paymentEventMatches({ to: TO.toUpperCase(), recipientFilter: TO }),
    ).toBe(true);
    expect(paymentEventMatches({ to: OTHER, recipientFilter: TO })).toBe(false);
    expect(paymentEventMatches({ to: 123, recipientFilter: TO })).toBe(false);
  });

  it("matches a full bytes32 memo exactly", () => {
    expect(paymentEventMatches({ to: TO, memo: HASH, memoFilter: HASH })).toBe(
      true,
    );
    expect(
      paymentEventMatches({
        to: TO,
        memo: HASH.toUpperCase(),
        memoFilter: HASH,
      }),
    ).toBe(true);
    expect(
      paymentEventMatches({ to: TO, memo: MEMO_INV1042, memoFilter: HASH }),
    ).toBe(false);
  });

  it("matches a plain-text memo as a utf8 prefix", () => {
    expect(
      paymentEventMatches({
        to: TO,
        memo: MEMO_INV1042,
        memoFilter: "INV-104",
      }),
    ).toBe(true);
    expect(
      paymentEventMatches({
        to: TO,
        memo: MEMO_INV1042,
        memoFilter: "INV-1042",
      }),
    ).toBe(true);
    expect(
      paymentEventMatches({ to: TO, memo: MEMO_INV1042, memoFilter: "ABC" }),
    ).toBe(false);
    expect(paymentEventMatches({ to: TO, memo: 42, memoFilter: "INV" })).toBe(
      false,
    );
  });

  it("requires both filters to pass when both are set", () => {
    expect(
      paymentEventMatches({
        to: TO,
        memo: MEMO_INV1042,
        recipientFilter: TO,
        memoFilter: "INV-104",
      }),
    ).toBe(true);
    expect(
      paymentEventMatches({
        to: OTHER,
        memo: MEMO_INV1042,
        recipientFilter: TO,
        memoFilter: "INV-104",
      }),
    ).toBe(false);
    expect(
      paymentEventMatches({
        to: TO,
        memo: MEMO_INV1042,
        recipientFilter: TO,
        memoFilter: "ZZZ",
      }),
    ).toBe(false);
  });
});
