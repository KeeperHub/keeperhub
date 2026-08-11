import { describe, expect, it } from "vitest";
import { resolveRequiredFactors } from "@/lib/mfa/step-up-policy";

const enrolledAll = { wallet: true, totp: true, email: true };
const enrolledNoTotp = { wallet: true, totp: false, email: true };
const enrolledSignatureOnly = { wallet: true, totp: false, email: false };

describe("resolveRequiredFactors", () => {
  it("forces dual-factor for non-wallet accounts", () => {
    expect(
      resolveRequiredFactors({ isWalletUser: false, enrolled: enrolledAll })
    ).toEqual(["totp", "email"]);
  });

  it("requires every enrolled extra factor for a wallet user", () => {
    expect(
      resolveRequiredFactors({ isWalletUser: true, enrolled: enrolledAll })
    ).toEqual(["wallet", "totp", "email"]);
  });

  it("requires only the factors the wallet user has enrolled", () => {
    expect(
      resolveRequiredFactors({ isWalletUser: true, enrolled: enrolledNoTotp })
    ).toEqual(["wallet", "email"]);
  });

  it("never blocks a wallet user with no extra factors (signature only)", () => {
    expect(
      resolveRequiredFactors({
        isWalletUser: true,
        enrolled: enrolledSignatureOnly,
      })
    ).toEqual(["wallet"]);
  });
});
