import { describe, expect, it } from "vitest";
import { walletAddressFromEmail } from "@/lib/auth/wallet-constants";

const ADDRESS = "0x52908400098527886e0f7030069857d2e4169ee7";

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
