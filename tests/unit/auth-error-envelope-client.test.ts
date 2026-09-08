import { describe, expect, it } from "vitest";
import {
  authErrorCode,
  authErrorMessage,
} from "@/lib/auth/auth-error-envelope-client";

describe("auth error envelope client helpers", () => {
  it("authErrorCode prefers legacy code when both fields are present", () => {
    expect(
      authErrorCode({
        error: "Invalid email code",
        code: "invalid_email_otp",
      })
    ).toBe("invalid_email_otp");
  });

  it("authErrorCode uses envelope error slug when code is absent", () => {
    expect(
      authErrorCode({
        error: "invalid_totp",
        detail: "Invalid authenticator code",
      })
    ).toBe("invalid_totp");
  });

  it("authErrorCode falls back to legacy code alone", () => {
    expect(authErrorCode({ code: "invalid_email_otp" })).toBe(
      "invalid_email_otp"
    );
  });

  it("authErrorMessage prefers detail for user-facing text", () => {
    expect(
      authErrorMessage(
        { error: "invalid_signin", detail: "Invalid sign-in" },
        "fallback"
      )
    ).toBe("Invalid sign-in");
  });

  it("authErrorMessage falls back to error then default", () => {
    expect(
      authErrorMessage({ error: "invalid_signin" }, "Sign in failed")
    ).toBe("invalid_signin");
    expect(authErrorMessage({}, "Sign in failed")).toBe("Sign in failed");
  });

  it("authErrorMessage uses legacy prose error when detail is absent", () => {
    expect(
      authErrorMessage(
        { error: "Invalid email code", code: "invalid_email_otp" },
        "fallback"
      )
    ).toBe("Invalid email code");
  });
});
