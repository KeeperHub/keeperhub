import { describe, expect, it } from "vitest";
import {
  findDuplicateKeys,
  inviteKey,
  isSelfInvite,
  isValidInvite,
} from "@/lib/onboarding/invite-validation";

// A valid EIP-55 checksummed address and its all-lowercase form.
const CHECKSUMMED = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const LOWERCASE = CHECKSUMMED.toLowerCase();
// Same hex but with a broken checksum (one letter case flipped).
const BAD_CHECKSUM = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1Beaed";

describe("isValidInvite", () => {
  it("accepts a normal email", () => {
    expect(isValidInvite("alice@example.com")).toBe(true);
  });

  it("rejects malformed emails", () => {
    expect(isValidInvite("not-an-email")).toBe(false);
    expect(isValidInvite("a@b")).toBe(false);
    expect(isValidInvite("")).toBe(false);
  });

  it("rejects disposable/blacklisted domains", () => {
    expect(isValidInvite("throwaway@mailinator.com")).toBe(false);
  });

  it("rejects synthetic wallet emails", () => {
    expect(isValidInvite(`${LOWERCASE}@wallet.keeperhub.com`)).toBe(false);
  });

  it("accepts checksummed and lowercase wallet addresses", () => {
    expect(isValidInvite(CHECKSUMMED)).toBe(true);
    expect(isValidInvite(LOWERCASE)).toBe(true);
  });

  it("rejects an address with a bad checksum or bad hex", () => {
    expect(isValidInvite(BAD_CHECKSUM)).toBe(false);
    expect(isValidInvite("0xnothex")).toBe(false);
  });
});

describe("isSelfInvite", () => {
  const selfEmail = "me@example.com";
  const selfAddress = LOWERCASE;

  it("matches the signed-in email case-insensitively", () => {
    expect(isSelfInvite("ME@Example.com", selfEmail, selfAddress)).toBe(true);
  });

  it("matches the signed-in wallet address case-insensitively", () => {
    expect(isSelfInvite(CHECKSUMMED, selfEmail, selfAddress)).toBe(true);
  });

  it("does not match a different contact", () => {
    expect(isSelfInvite("other@example.com", selfEmail, selfAddress)).toBe(
      false
    );
  });

  it("is false for empty input or missing self identifiers", () => {
    expect(isSelfInvite("", selfEmail, selfAddress)).toBe(false);
    expect(isSelfInvite("me@example.com", undefined, "")).toBe(false);
  });
});

describe("findDuplicateKeys", () => {
  it("flags case-insensitive collisions and ignores blanks", () => {
    const dups = findDuplicateKeys(["a@x.com", "A@x.com", "b@x.com", "", "  "]);
    expect([...dups]).toEqual(["a@x.com"]);
  });

  it("returns an empty set when everything is unique", () => {
    expect(findDuplicateKeys(["a@x.com", "b@x.com"]).size).toBe(0);
  });
});

describe("inviteKey", () => {
  it("trims and lowercases", () => {
    expect(inviteKey("  Foo@Bar.COM ")).toBe("foo@bar.com");
  });
});
