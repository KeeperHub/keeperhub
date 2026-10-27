import { describe, expect, it } from "vitest";
import { loginIdentifier } from "@/components/settings/hub/members/login-identifier";
import { walletAddressFromEmail } from "@/lib/auth/wallet-constants";

const ADDRESS = "0x52908400098527886e0f7030069857d2e4169ee7";
const CHECKSUMMED = "0x52908400098527886E0F7030069857D2E4169EE7";

describe("walletAddressFromEmail", () => {
  it("returns the address a wallet email carries", () => {
    expect(walletAddressFromEmail(`${ADDRESS}@wallet.keeperhub.com`)).toBe(
      ADDRESS
    );
  });

  it("returns null for a mailbox, an empty value or no value", () => {
    expect(walletAddressFromEmail("robin@example.com")).toBeNull();
    expect(walletAddressFromEmail("")).toBeNull();
    expect(walletAddressFromEmail(null)).toBeNull();
    expect(walletAddressFromEmail(undefined)).toBeNull();
  });
});

describe("loginIdentifier", () => {
  it("shows a wallet account as its short checksummed address", () => {
    expect(loginIdentifier(`${ADDRESS}@wallet.keeperhub.com`)).toEqual({
      shown: "0x5290...9EE7",
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
