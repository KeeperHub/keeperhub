import { expect, test } from "./fixtures";
import {
  completeWalletLogin,
  installWalletStub,
  signWithTestWallet,
} from "./utils/wallet-stub";

// Wallet step-up: a sensitive action (create API key) requires a fresh wallet
// signature for SIWE users. Sign in via the stub, then exercise the step-up
// contract end-to-end against the real endpoint with the real session.
test.use({ storageState: { cookies: [], origins: [] } });

test.describe("wallet step-up", () => {
  test("create API key challenges, then succeeds once signed", async ({
    page,
    apiRequest,
  }) => {
    await installWalletStub(page);
    await completeWalletLogin(page);

    const name = "e2e step-up key";

    // First call: no signature -> the endpoint demands one and returns the
    // challenge to sign.
    const challengeRes = await apiRequest.post("/api/api-keys", {
      data: { name },
    });
    expect(challengeRes.status()).toBe(401);
    const challengeBody = (await challengeRes.json()) as {
      code?: string;
      challenge?: string;
      required?: string[];
    };
    expect(challengeBody.code).toBe("signature_required");
    expect(challengeBody.required).toContain("wallet");
    expect(challengeBody.challenge).toBeTruthy();

    // Sign the challenge with the wallet and retry.
    const signature = await signWithTestWallet(challengeBody.challenge ?? "");
    const okRes = await apiRequest.post("/api/api-keys", {
      data: { name, signature },
    });
    expect(okRes.ok()).toBeTruthy();

    // A bad signature is rejected.
    const badRes = await apiRequest.post("/api/api-keys", {
      data: { name: "rejected", signature: "0xdeadbeef" },
    });
    expect(badRes.ok()).toBeFalsy();
  });
});
