import { describe, expect, it } from "vitest";
import { resolveReturnUrl } from "@/lib/billing/return-url";

const APP = "https://app.example.com";
const FALLBACK = `${APP}/billing`;

describe("resolveReturnUrl", () => {
  it("returns to the page the portal was opened from", () => {
    expect(resolveReturnUrl(APP, "/settings/org_123/billing")).toBe(
      `${APP}/settings/org_123/billing`
    );
  });

  it("keeps the query string", () => {
    expect(resolveReturnUrl(APP, "/settings/org_123/billing?highlight=x")).toBe(
      `${APP}/settings/org_123/billing?highlight=x`
    );
  });

  it("refuses to send the user to another origin", () => {
    for (const hostile of [
      "https://evil.example.com/steal",
      "//evil.example.com/steal",
      "/\\evil.example.com",
      "javascript:alert(1)",
      "",
    ]) {
      expect(resolveReturnUrl(APP, hostile)).toBe(FALLBACK);
    }
  });

  it("falls back when nothing usable is given", () => {
    expect(resolveReturnUrl(APP, undefined)).toBe(FALLBACK);
    expect(resolveReturnUrl(APP, 42)).toBe(FALLBACK);
    expect(resolveReturnUrl(APP, { toString: () => "/x" })).toBe(FALLBACK);
  });
});
