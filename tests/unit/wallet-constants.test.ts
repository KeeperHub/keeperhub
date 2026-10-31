import { describe, expect, it } from "vitest";
import {
  WALLET_EMAIL_DOMAIN,
  walletAddressFromEmail,
} from "@/lib/auth/wallet-constants";

// A synthetic fixture (mostly zeros), not a deployed address.
const ADDRESS = "0x00000000000000000000000000000000deadbeef";

describe("walletAddressFromEmail", () => {
  it("returns the address a wallet email carries", () => {
    expect(walletAddressFromEmail(`${ADDRESS}@${WALLET_EMAIL_DOMAIN}`)).toBe(
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
