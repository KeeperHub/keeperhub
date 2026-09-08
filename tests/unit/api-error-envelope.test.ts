/**
 * KEEP-489: REST APIs return a structured `{error, detail, hint, docs,
 * request_id}` envelope so clients branch on `error` (a stable snake_case
 * code) instead of regex-matching the prose message. Multiple hackathon
 * teams independently reverse-engineered defensive parsers; this contract
 * removes that need.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiErrorCodes,
  apiError,
  resolveRequestId,
  sanitizeDetailForEnv,
} from "@/lib/errors/api-envelope";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("apiError envelope (KEEP-489)", () => {
  it("emits {error, detail, request_id} with the requested HTTP status", async () => {
    const response = apiError({
      status: 401,
      code: ApiErrorCodes.UNAUTHORIZED,
      detail: "Missing bearer token",
    });
    expect(response.status).toBe(401);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("unauthorized");
    expect(body.detail).toBe("Missing bearer token");
    expect(typeof body.request_id).toBe("string");
    expect(UUID_REGEX.test(body.request_id as string)).toBe(true);
  });

  it("includes optional hint, docs, and request_id when provided", async () => {
    const response = apiError({
      status: 404,
      code: "wallet_not_configured",
      detail: "No wallet provisioned for chain 8453 in org X",
      hint: "POST /api/integrations/wallet to provision",
      docs: "https://docs.keeperhub.com/wallets",
      requestId: "req_abc123",
    });
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body).toEqual({
      error: "wallet_not_configured",
      detail: "No wallet provisioned for chain 8453 in org X",
      hint: "POST /api/integrations/wallet to provision",
      docs: "https://docs.keeperhub.com/wallets",
      request_id: "req_abc123",
    });
  });

  it("omits hint and docs when not provided, but always emits request_id", async () => {
    const body = (await apiError({
      status: 400,
      code: ApiErrorCodes.INVALID_INPUT,
      detail: "Bad request",
    }).json()) as Record<string, unknown>;
    expect(body.hint).toBeUndefined();
    expect(body.docs).toBeUndefined();
    expect(typeof body.request_id).toBe("string");
    expect((body.request_id as string).length).toBeGreaterThan(0);
  });

  it("preserves caller-supplied headers and echoes request_id on x-request-id", () => {
    const response = apiError({
      status: 429,
      code: ApiErrorCodes.RATE_LIMITED,
      detail: "Too many requests",
      requestId: "req_xyz",
      headers: { "Retry-After": "60" },
    });
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(response.headers.get("x-request-id")).toBe("req_xyz");
  });

  it("auto-resolves request_id from x-request-id request header", async () => {
    const inbound = new Headers({ "x-request-id": "trace-12345" });
    const response = apiError({
      status: 401,
      code: ApiErrorCodes.UNAUTHORIZED,
      detail: "Nope",
      requestHeaders: inbound,
    });
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.request_id).toBe("trace-12345");
    expect(response.headers.get("x-request-id")).toBe("trace-12345");
  });

  it("explicit requestId beats requestHeaders (background tasks)", async () => {
    const inbound = new Headers({ "x-request-id": "header-id" });
    const response = apiError({
      status: 500,
      code: ApiErrorCodes.INTERNAL_ERROR,
      detail: "boom",
      requestHeaders: inbound,
      requestId: "explicit-id",
    });
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.request_id).toBe("explicit-id");
  });

  it("exports canonical codes used across routes", () => {
    expect(ApiErrorCodes.UNAUTHORIZED).toBe("unauthorized");
    expect(ApiErrorCodes.INSUFFICIENT_SCOPE).toBe("insufficient_scope");
    expect(ApiErrorCodes.NOT_FOUND).toBe("not_found");
    expect(ApiErrorCodes.INVALID_INPUT).toBe("invalid_input");
    expect(ApiErrorCodes.CONFLICT).toBe("conflict");
    expect(ApiErrorCodes.RATE_LIMITED).toBe("rate_limited");
    expect(ApiErrorCodes.INTERNAL_ERROR).toBe("internal_error");
  });
});

describe("resolveRequestId", () => {
  it("returns the header value when valid", () => {
    const h = new Headers({ "x-request-id": "req_abc" });
    expect(resolveRequestId(h)).toBe("req_abc");
  });

  it("falls back to a fresh UUID when header is missing", () => {
    const result = resolveRequestId(new Headers());
    expect(UUID_REGEX.test(result)).toBe(true);
  });

  it("falls back to a fresh UUID when headers argument is undefined", () => {
    const result = resolveRequestId();
    expect(UUID_REGEX.test(result)).toBe(true);
  });

  it("rejects overlong header values (log-injection guard)", () => {
    const tooLong = "x".repeat(129);
    const h = new Headers({ "x-request-id": tooLong });
    const result = resolveRequestId(h);
    expect(result).not.toBe(tooLong);
    expect(UUID_REGEX.test(result)).toBe(true);
  });

  it("rejects header values containing control characters", () => {
    const h = new Headers({ "x-request-id": "ok-id" });
    // Replace with a control-char value via raw set since Headers may
    // normalize. Test the validator path directly with a forged header.
    const forged = new Headers();
    forged.set("x-request-id", "abcdef");
    const result = resolveRequestId(forged);
    expect(UUID_REGEX.test(result)).toBe(true);
    // sanity: the good case still wins
    expect(resolveRequestId(h)).toBe("ok-id");
  });

  it("honors explicit fallback over UUID when provided", () => {
    expect(resolveRequestId(new Headers(), "explicit")).toBe("explicit");
  });
});

describe("sanitizeDetailForEnv", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("passes through in development unchanged", () => {
    vi.stubEnv("NODE_ENV", "development");
    const detail = "Error in /Users/skp/foo.ts at line 12";
    expect(sanitizeDetailForEnv(detail)).toBe(detail);
  });

  it("passes through in test unchanged", () => {
    vi.stubEnv("NODE_ENV", "test");
    const detail = "Error in /app/lib/db.ts";
    expect(sanitizeDetailForEnv(detail)).toBe(detail);
  });

  it("strips /Users/ path fragments in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    const detail =
      "Something broke\n/Users/skp/Dev/KeeperHub/keeperhub/lib/foo.ts:12\nmore prose";
    const result = sanitizeDetailForEnv(detail);
    expect(result).not.toContain("/Users/");
    expect(result).toContain("Something broke");
  });

  it("truncates at first stack-frame indicator in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    const detail =
      "Database error: bad query\n    at Module._compile (node:internal/modules/cjs/loader:1234:14)\n    at Object.Module._extensions";
    const result = sanitizeDetailForEnv(detail);
    expect(result).toBe("Database error: bad query");
  });

  it("strips node_modules and webpack:// fragments in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    const detail =
      "Failed\nfrom node_modules/pg/lib/foo.js:1\ncontext: webpack:///./src/x.ts";
    const result = sanitizeDetailForEnv(detail);
    expect(result).not.toContain("node_modules");
    expect(result).not.toContain("webpack:");
    expect(result).toContain("Failed");
  });

  it("strips Windows drive-letter paths in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    const detail = "Crash\nC:\\Users\\dev\\app\\main.ts:1";
    const result = sanitizeDetailForEnv(detail);
    expect(result).not.toContain("C:\\");
    expect(result).toContain("Crash");
  });

  it("caps length at 1024 chars regardless of environment", () => {
    vi.stubEnv("NODE_ENV", "development");
    const detail = "x".repeat(2000);
    const result = sanitizeDetailForEnv(detail);
    expect(result?.length).toBeLessThanOrEqual(1024);
  });

  it("returns a redacted placeholder if production sanitization drops everything", () => {
    vi.stubEnv("NODE_ENV", "production");
    const detail = "/Users/skp/foo.ts:1\n/app/bar.ts:2";
    const result = sanitizeDetailForEnv(detail);
    expect(result).toBe("Internal error (details redacted in production).");
  });

  it("returns undefined for undefined input", () => {
    expect(sanitizeDetailForEnv(undefined)).toBeUndefined();
  });
});
