import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { validateHttpRequestEndpoint } from "@/lib/workflow/nodes/http-request/perform";

describe("validateHttpRequestEndpoint", () => {
  it("trims surrounding whitespace before validation", () => {
    const result = validateHttpRequestEndpoint("  https://example.com/path  ");
    expect(result).toEqual({
      ok: true,
      endpoint: "https://example.com/path",
    });
  });

  it("rejects empty input", () => {
    expect(validateHttpRequestEndpoint("")).toEqual({
      ok: false,
      error: "HTTP request failed: URL is required",
    });
  });

  it("rejects whitespace-only input as missing URL", () => {
    expect(validateHttpRequestEndpoint("   ")).toEqual({
      ok: false,
      error: "HTTP request failed: URL is required",
    });
  });

  it("rejects null and undefined", () => {
    expect(validateHttpRequestEndpoint(undefined)).toEqual({
      ok: false,
      error: "HTTP request failed: URL is required",
    });
    expect(validateHttpRequestEndpoint(null)).toEqual({
      ok: false,
      error: "HTTP request failed: URL is required",
    });
  });

  it("flags a single unresolved template variable", () => {
    expect(
      validateHttpRequestEndpoint(
        "https://meritscore.warvis.org/merit/{{address}}"
      )
    ).toEqual({
      ok: false,
      error:
        "HTTP request failed: Missing template variable(s) in URL: address",
    });
  });

  it("flags multiple unresolved variables in stable order", () => {
    const result = validateHttpRequestEndpoint(
      "https://api.example.com/{{userId}}/orders/{{orderId}}"
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(
        "HTTP request failed: Missing template variable(s) in URL: userId, orderId"
      );
    }
  });

  it("deduplicates repeated unresolved variables", () => {
    const result = validateHttpRequestEndpoint(
      "https://api.example.com/{{id}}/{{id}}"
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(
        "HTTP request failed: Missing template variable(s) in URL: id"
      );
    }
  });

  it("flags stored-format references when not substituted", () => {
    const result = validateHttpRequestEndpoint(
      "https://api.example.com/{{@node1:Trigger.address}}"
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain(
        "Missing template variable(s) in URL: @node1:Trigger.address"
      );
    }
  });

  it("reproduces the prod incident: leading whitespace plus unresolved variable", () => {
    const result = validateHttpRequestEndpoint(
      " https://meritscore.warvis.org/merit/{{address}}"
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(
        "HTTP request failed: Missing template variable(s) in URL: address"
      );
    }
  });

  it("accepts a fully resolved URL", () => {
    expect(
      validateHttpRequestEndpoint("https://api.example.com/v1/orders")
    ).toEqual({ ok: true, endpoint: "https://api.example.com/v1/orders" });
  });
});
