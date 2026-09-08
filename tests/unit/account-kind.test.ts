import { describe, expect, it } from "vitest";
import { classifyAccountKind } from "@/lib/auth/account-kind";

describe("classifyAccountKind", () => {
  it("classifies a wallet (SIWE) email as wallet", () => {
    expect(classifyAccountKind({ email: "0xabc@wallet.keeperhub.com" })).toBe(
      "wallet"
    );
  });

  it("classifies the siwe providerId as wallet", () => {
    expect(
      classifyAccountKind({ email: "anything@x.com", providerId: "siwe" })
    ).toBe("wallet");
  });

  it("classifies github / google providerId as oauth", () => {
    expect(
      classifyAccountKind({ email: "u@gmail.com", providerId: "github" })
    ).toBe("oauth");
    expect(
      classifyAccountKind({ email: "u@gmail.com", providerId: "google" })
    ).toBe("oauth");
  });

  it("classifies the credential providerId as email", () => {
    expect(
      classifyAccountKind({ email: "u@x.com", providerId: "credential" })
    ).toBe("email");
  });

  it("classifies a normal email with no providerId as email", () => {
    expect(classifyAccountKind({ email: "u@x.com" })).toBe("email");
  });

  it("treats an OAuth account as email when providerId is not supplied", () => {
    // Documented coarsening: wallet-vs-not is preserved, oauth collapses to email.
    expect(classifyAccountKind({ email: "u@gmail.com" })).toBe("email");
  });

  it("classifies anonymous via the isAnonymous column, name, or temp email", () => {
    expect(classifyAccountKind({ email: "u@x.com", isAnonymous: true })).toBe(
      "anonymous"
    );
    expect(classifyAccountKind({ email: "u@x.com", name: "Anonymous" })).toBe(
      "anonymous"
    );
    expect(classifyAccountKind({ email: "temp-123@x.com" })).toBe("anonymous");
  });

  it("lets anonymous win over a wallet email", () => {
    expect(
      classifyAccountKind({
        email: "0xabc@wallet.keeperhub.com",
        isAnonymous: true,
      })
    ).toBe("anonymous");
  });

  it("keeps a wallet email as wallet when not anonymous", () => {
    expect(
      classifyAccountKind({
        email: "0xabc@wallet.keeperhub.com",
        isAnonymous: false,
      })
    ).toBe("wallet");
  });
});
