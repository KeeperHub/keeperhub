import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authenticateAdmin,
  rateLimitBypassRule,
  validateTestEmail,
} from "@/lib/admin-auth";

const TEST_KEY = "kha_test-secret-key-12345";

function createRequest(token?: string): Request {
  const headers: Record<string, string> = {};
  if (token !== undefined) {
    headers.Authorization = token;
  }
  return new Request("http://localhost:3000/api/admin/test/otp", { headers });
}

describe("authenticateAdmin", () => {
  beforeEach(() => {
    delete process.env.TEST_API_KEY;
    vi.stubEnv("NODE_ENV", "");
    vi.stubEnv("ALLOW_TEST_ENDPOINTS", "");
    // Assume routes are compiled in unless a specific test overrides.
    // Without this, every test below would trip the build-time gate.
    vi.stubEnv("INCLUDE_TEST_ENDPOINTS", "true");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("should refuse when INCLUDE_TEST_ENDPOINTS is not baked in (build-time gate)", () => {
    process.env.TEST_API_KEY = TEST_KEY;
    vi.stubEnv("INCLUDE_TEST_ENDPOINTS", "");
    const result = authenticateAdmin(createRequest(`Bearer ${TEST_KEY}`));
    expect(result).toEqual({
      authenticated: false,
      error: "Admin test endpoints disabled in production",
    });
  });

  it("should refuse when INCLUDE_TEST_ENDPOINTS is any value other than 'true'", () => {
    process.env.TEST_API_KEY = TEST_KEY;
    vi.stubEnv("INCLUDE_TEST_ENDPOINTS", "1");
    const result = authenticateAdmin(createRequest(`Bearer ${TEST_KEY}`));
    expect(result.authenticated).toBe(false);
  });

  it("should reject when TEST_API_KEY is not configured", () => {
    const result = authenticateAdmin(createRequest(`Bearer ${TEST_KEY}`));
    expect(result).toEqual({
      authenticated: false,
      error: "Admin API not configured",
    });
  });

  it("should reject when Authorization header is missing", () => {
    process.env.TEST_API_KEY = TEST_KEY;
    const result = authenticateAdmin(createRequest());
    expect(result).toEqual({
      authenticated: false,
      error: "Missing or invalid Authorization header",
    });
  });

  it("should reject non-Bearer auth scheme", () => {
    process.env.TEST_API_KEY = TEST_KEY;
    const result = authenticateAdmin(createRequest("Basic dXNlcjpwYXNz"));
    expect(result).toEqual({
      authenticated: false,
      error: "Missing or invalid Authorization header",
    });
  });

  it("should reject wrong key", () => {
    process.env.TEST_API_KEY = TEST_KEY;
    const result = authenticateAdmin(createRequest("Bearer wrong-key"));
    expect(result).toEqual({
      authenticated: false,
      error: "Invalid admin API key",
    });
  });

  it("should reject key with different length", () => {
    process.env.TEST_API_KEY = TEST_KEY;
    const result = authenticateAdmin(createRequest("Bearer short"));
    expect(result).toEqual({
      authenticated: false,
      error: "Invalid admin API key",
    });
  });

  it("should accept correct key", () => {
    process.env.TEST_API_KEY = TEST_KEY;
    const result = authenticateAdmin(createRequest(`Bearer ${TEST_KEY}`));
    expect(result).toEqual({ authenticated: true });
  });

  it("should refuse in production even with a valid key", () => {
    process.env.TEST_API_KEY = TEST_KEY;
    vi.stubEnv("NODE_ENV", "production");
    const result = authenticateAdmin(createRequest(`Bearer ${TEST_KEY}`));
    expect(result).toEqual({
      authenticated: false,
      error: "Admin test endpoints disabled in production",
    });
  });

  it("should refuse in production when ALLOW_TEST_ENDPOINTS is set to anything other than 'true'", () => {
    process.env.TEST_API_KEY = TEST_KEY;
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ALLOW_TEST_ENDPOINTS", "1");
    const result = authenticateAdmin(createRequest(`Bearer ${TEST_KEY}`));
    expect(result.authenticated).toBe(false);
  });

  it("should accept in production when ALLOW_TEST_ENDPOINTS=true override is set", () => {
    process.env.TEST_API_KEY = TEST_KEY;
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ALLOW_TEST_ENDPOINTS", "true");
    const result = authenticateAdmin(createRequest(`Bearer ${TEST_KEY}`));
    expect(result).toEqual({ authenticated: true });
  });

  it("should not refuse in non-production environments", () => {
    process.env.TEST_API_KEY = TEST_KEY;
    vi.stubEnv("NODE_ENV", "development");
    const result = authenticateAdmin(createRequest(`Bearer ${TEST_KEY}`));
    expect(result).toEqual({ authenticated: true });
  });
});

describe("rateLimitBypassRule", () => {
  const DEFAULT_RULE = { window: 60, max: 10 };

  function createRequestWithHeader(header?: string): Request {
    const headers: Record<string, string> = {};
    if (header !== undefined) {
      headers["X-Test-API-Key"] = header;
    }
    return new Request("http://localhost:3000/api/auth/sign-in", { headers });
  }

  beforeEach(() => {
    delete process.env.TEST_API_KEY;
    vi.stubEnv("NODE_ENV", "");
    vi.stubEnv("ALLOW_TEST_ENDPOINTS", "");
    vi.stubEnv("INCLUDE_TEST_ENDPOINTS", "true");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("should return default rule when build-time gate refuses", () => {
    process.env.TEST_API_KEY = TEST_KEY;
    vi.stubEnv("INCLUDE_TEST_ENDPOINTS", "");
    const result = rateLimitBypassRule(
      createRequestWithHeader(TEST_KEY),
      DEFAULT_RULE
    );
    expect(result).toBe(DEFAULT_RULE);
  });

  it("should return default rule in production without ALLOW_TEST_ENDPOINTS", () => {
    process.env.TEST_API_KEY = TEST_KEY;
    vi.stubEnv("NODE_ENV", "production");
    const result = rateLimitBypassRule(
      createRequestWithHeader(TEST_KEY),
      DEFAULT_RULE
    );
    expect(result).toBe(DEFAULT_RULE);
  });

  it("should return default rule when TEST_API_KEY is not set", () => {
    const result = rateLimitBypassRule(
      createRequestWithHeader(TEST_KEY),
      DEFAULT_RULE
    );
    expect(result).toBe(DEFAULT_RULE);
  });

  it("should return default rule when X-Test-API-Key header is missing", () => {
    process.env.TEST_API_KEY = TEST_KEY;
    const result = rateLimitBypassRule(createRequestWithHeader(), DEFAULT_RULE);
    expect(result).toBe(DEFAULT_RULE);
  });

  it("should return default rule when X-Test-API-Key header is wrong", () => {
    process.env.TEST_API_KEY = TEST_KEY;
    const result = rateLimitBypassRule(
      createRequestWithHeader("wrong-key"),
      DEFAULT_RULE
    );
    expect(result).toBe(DEFAULT_RULE);
  });

  it("should return false (bypass) when all gates pass and header matches", () => {
    process.env.TEST_API_KEY = TEST_KEY;
    const result = rateLimitBypassRule(
      createRequestWithHeader(TEST_KEY),
      DEFAULT_RULE
    );
    expect(result).toBe(false);
  });

  it("should bypass in production when ALLOW_TEST_ENDPOINTS=true and header matches", () => {
    process.env.TEST_API_KEY = TEST_KEY;
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ALLOW_TEST_ENDPOINTS", "true");
    const result = rateLimitBypassRule(
      createRequestWithHeader(TEST_KEY),
      DEFAULT_RULE
    );
    expect(result).toBe(false);
  });
});

describe("validateTestEmail", () => {
  it("should accept @techops.services emails", () => {
    expect(validateTestEmail("user@techops.services")).toBeNull();
    expect(validateTestEmail("test+signup@techops.services")).toBeNull();
  });

  it("should reject non-techops emails", () => {
    expect(validateTestEmail("user@gmail.com")).toBe(
      "Email must end with @techops.services"
    );
  });

  it("should reject empty string", () => {
    expect(validateTestEmail("")).toBe("Email must end with @techops.services");
  });
});
