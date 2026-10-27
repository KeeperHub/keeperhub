import { describe, expect, it } from "vitest";
import { loginIdentifier } from "@/components/settings/hub/members/login-identifier";

const ADDRESS = "0x52908400098527886e0f7030069857d2e4169ee7";
const CHECKSUMMED = "0x52908400098527886E0F7030069857D2E4169EE7";

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
