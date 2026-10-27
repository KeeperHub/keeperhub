import { describe, expect, it } from "vitest";
import { loginIdentifier } from "@/components/settings/hub/members/login-identifier";
import { WALLET_EMAIL_DOMAIN } from "@/lib/auth/wallet-constants";

// A synthetic fixture (mostly zeros), not a deployed address.
const ADDRESS = "0x00000000000000000000000000000000deadbeef";
const CHECKSUMMED = "0x00000000000000000000000000000000DeaDBeef";

describe("loginIdentifier", () => {
  it("shows a wallet account as its short checksummed address", () => {
    expect(loginIdentifier(`${ADDRESS}@${WALLET_EMAIL_DOMAIN}`)).toEqual({
      shown: "0x0000...Beef",
      full: CHECKSUMMED,
    });
  });

  it("shows an email account as its email", () => {
    expect(loginIdentifier("robin@example.com")).toEqual({
      shown: "robin@example.com",
      full: "robin@example.com",
    });
  });
});
