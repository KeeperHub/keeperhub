import { describe, expect, it } from "vitest";
import {
  parseEnforcedFactors,
  satisfiesEnforcement,
} from "@/lib/mfa/org-mfa-enforcement";

describe("parseEnforcedFactors", () => {
  it("keeps only the enforceable factors (totp, email)", () => {
    expect(parseEnforcedFactors(["totp", "email", "wallet", "nope"])).toEqual([
      "totp",
      "email",
    ]);
  });

  it("returns an empty list for non-array input", () => {
    expect(parseEnforcedFactors(null)).toEqual([]);
    expect(parseEnforcedFactors("totp")).toEqual([]);
  });

  it("dedupes repeated factors", () => {
    expect(parseEnforcedFactors(["totp", "totp"])).toEqual(["totp"]);
  });
});

describe("satisfiesEnforcement", () => {
  it("fails a member missing any required factor when both are required", () => {
    expect(
      satisfiesEnforcement(["totp", "email"], { totp: false, email: true })
    ).toBe(false);
  });

  it("passes a member carrying every required factor", () => {
    expect(
      satisfiesEnforcement(["totp", "email"], { totp: true, email: true })
    ).toBe(true);
  });

  it("fails a member carrying none of the required factors", () => {
    expect(satisfiesEnforcement(["totp"], { totp: false, email: true })).toBe(
      false
    );
  });

  it("passes when the single required factor is enrolled", () => {
    expect(satisfiesEnforcement(["totp"], { totp: true, email: false })).toBe(
      true
    );
  });
});
