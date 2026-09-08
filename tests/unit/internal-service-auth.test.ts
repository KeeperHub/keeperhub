/**
 * Verifier unit tests for lib/internal-service-auth.ts.
 *
 * Mocks the secret store so the tests run without a DB. The canonical signing
 * string is re-implemented here (not imported from the verifier) so a typo in
 * either side is caught by a test failure rather than masked by shared code.
 */

import { createHash, createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockLookup, mockListActive, activeSecrets } = vi.hoisted(() => ({
  mockLookup:
    vi.fn<
      (
        caller: string,
        keyVersion?: number
      ) => Promise<{ secret: string; keyVersion: number } | null>
    >(),
  mockListActive:
    vi.fn<
      (caller: string) => Promise<{ secret: string; keyVersion: number }[]>
    >(),
  activeSecrets: [] as { secret: string; keyVersion: number }[],
}));

vi.mock("@/lib/internal-service-hmac-store", () => ({
  lookupHmacSecret: mockLookup,
  listActiveHmacSecrets: mockListActive,
  insertHmacSecret: vi.fn(),
}));

const SHARED_SECRET = "test-shared-secret-do-not-use-in-production";
const REPLAY_WINDOW_SECONDS = 300;
const SECRET_LOOKUP_KEY = "*shared*";

function signCanonical(opts: {
  secret: string;
  method: string;
  pathname: string;
  caller: string;
  body: string;
  timestamp: string;
}): string {
  const bodyDigest = createHash("sha256").update(opts.body).digest("hex");
  const signingString = `${opts.method}\n${opts.pathname}\n${opts.caller}\n${bodyDigest}\n${opts.timestamp}`;
  return createHmac("sha256", opts.secret).update(signingString).digest("hex");
}

function buildRequest(opts: {
  method?: string;
  pathname?: string;
  body?: string;
  headers?: Record<string, string>;
}): Request {
  const method = opts.method ?? "POST";
  const pathname = opts.pathname ?? "/api/internal/executions";
  const url = `http://localhost${pathname}`;
  const init: RequestInit = {
    method,
    headers: opts.headers,
  };
  // Only attach a body for methods that allow one. GET requests with a body
  // would throw in fetch/Request construction.
  if (method !== "GET" && method !== "HEAD" && opts.body !== undefined) {
    init.body = opts.body;
  }
  return new Request(url, init);
}

function signedHeaders(opts: {
  method: string;
  pathname: string;
  caller: string;
  body: string;
  secret?: string;
  timestamp?: string;
  keyVersion?: string;
}): Record<string, string> {
  const timestamp = opts.timestamp ?? String(Math.floor(Date.now() / 1000));
  const signature = signCanonical({
    secret: opts.secret ?? SHARED_SECRET,
    method: opts.method,
    pathname: opts.pathname,
    caller: opts.caller,
    body: opts.body,
    timestamp,
  });
  const headers: Record<string, string> = {
    "X-KH-Caller": opts.caller,
    "X-KH-Timestamp": timestamp,
    "X-KH-Signature": signature,
  };
  if (opts.keyVersion !== undefined) {
    headers["X-KH-Key-Version"] = opts.keyVersion;
  }
  return headers;
}

describe("authenticateInternalService - HMAC scheme", () => {
  beforeEach(() => {
    activeSecrets.length = 0;
    activeSecrets.push({ secret: SHARED_SECRET, keyVersion: 1 });
    mockLookup.mockReset();
    mockListActive.mockReset();
    mockListActive.mockImplementation(() =>
      Promise.resolve(activeSecrets.slice())
    );
    mockLookup.mockImplementation((_caller, keyVersion) => {
      if (keyVersion === undefined) {
        return Promise.resolve(activeSecrets.at(-1) ?? null);
      }
      return Promise.resolve(
        activeSecrets.find((s) => s.keyVersion === keyVersion) ?? null
      );
    });
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("accepts a valid signed POST and looks up the shared secret", async () => {
    const { authenticateInternalService } = await import(
      "@/lib/internal-service-auth"
    );
    const body = JSON.stringify({ workflowId: "wf1", userId: "u1" });
    const headers = signedHeaders({
      method: "POST",
      pathname: "/api/internal/executions",
      caller: "scheduler",
      body,
    });
    const request = buildRequest({
      method: "POST",
      pathname: "/api/internal/executions",
      headers,
      body,
    });

    const result = await authenticateInternalService(request, body);

    expect(result).toEqual({
      authenticated: true,
      caller: "scheduler",
      scheme: "hmac",
      keyVersion: 1,
    });
    expect(mockListActive).toHaveBeenCalledWith(SECRET_LOOKUP_KEY);
  });

  it("accepts a valid signed GET with empty body", async () => {
    const { authenticateInternalService } = await import(
      "@/lib/internal-service-auth"
    );
    const headers = signedHeaders({
      method: "GET",
      pathname: "/api/internal/schedules",
      caller: "scheduler",
      body: "",
    });
    const request = buildRequest({
      method: "GET",
      pathname: "/api/internal/schedules",
      headers,
    });

    const result = await authenticateInternalService(request);

    expect(result.authenticated).toBe(true);
  });

  it("rejects a request whose body was tampered after signing", async () => {
    const { authenticateInternalService } = await import(
      "@/lib/internal-service-auth"
    );
    const signedBody = JSON.stringify({ workflowId: "wf1", userId: "u1" });
    const headers = signedHeaders({
      method: "POST",
      pathname: "/api/internal/executions",
      caller: "scheduler",
      body: signedBody,
    });
    const tamperedBody = JSON.stringify({
      workflowId: "wf1",
      userId: "attacker",
    });
    const request = buildRequest({
      method: "POST",
      pathname: "/api/internal/executions",
      headers,
      body: tamperedBody,
    });

    const result = await authenticateInternalService(request, tamperedBody);

    expect(result).toMatchObject({
      authenticated: false,
      status: 401,
      error: "Invalid signature",
    });
  });

  it("rejects when the X-KH-Caller header is swapped to a different caller", async () => {
    const { authenticateInternalService } = await import(
      "@/lib/internal-service-auth"
    );
    const body = "";
    const validHeaders = signedHeaders({
      method: "GET",
      pathname: "/api/internal/schedules",
      caller: "scheduler",
      body,
    });
    validHeaders["X-KH-Caller"] = "executor";
    const request = buildRequest({
      method: "GET",
      pathname: "/api/internal/schedules",
      headers: validHeaders,
    });

    const result = await authenticateInternalService(request);

    expect(result.authenticated).toBe(false);
  });

  it("rejects a timestamp older than the replay window", async () => {
    const { authenticateInternalService } = await import(
      "@/lib/internal-service-auth"
    );
    const staleTs = String(
      Math.floor(Date.now() / 1000) - REPLAY_WINDOW_SECONDS - 10
    );
    const body = "";
    const headers = signedHeaders({
      method: "GET",
      pathname: "/api/internal/schedules",
      caller: "scheduler",
      body,
      timestamp: staleTs,
    });
    const request = buildRequest({
      method: "GET",
      pathname: "/api/internal/schedules",
      headers,
    });

    const result = await authenticateInternalService(request);

    expect(result).toMatchObject({
      authenticated: false,
      status: 401,
      error: "Timestamp outside replay window",
    });
  });

  it("rejects an unknown caller value in X-KH-Caller", async () => {
    const { authenticateInternalService } = await import(
      "@/lib/internal-service-auth"
    );
    const body = "";
    const headers = signedHeaders({
      method: "GET",
      pathname: "/api/internal/schedules",
      caller: "rogue-service",
      body,
    });
    const request = buildRequest({
      method: "GET",
      pathname: "/api/internal/schedules",
      headers,
    });

    const result = await authenticateInternalService(request);

    expect(result).toMatchObject({
      authenticated: false,
      error: "Unknown caller",
    });
  });

  it("rejects a signature of the wrong length before touching the secret store", async () => {
    const { authenticateInternalService } = await import(
      "@/lib/internal-service-auth"
    );
    const request = buildRequest({
      method: "GET",
      pathname: "/api/internal/schedules",
      headers: {
        "X-KH-Caller": "scheduler",
        "X-KH-Timestamp": String(Math.floor(Date.now() / 1000)),
        "X-KH-Signature": "deadbeef",
      },
    });

    const result = await authenticateInternalService(request);

    expect(result).toMatchObject({
      authenticated: false,
      error: "Invalid signature",
    });
    expect(mockListActive).not.toHaveBeenCalled();
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("accepts a request signed with a still-active prior key version", async () => {
    const { authenticateInternalService } = await import(
      "@/lib/internal-service-auth"
    );
    const OLD_SECRET = "old-secret";
    const NEW_SECRET = "new-secret";
    activeSecrets.length = 0;
    activeSecrets.push({ secret: OLD_SECRET, keyVersion: 1 });
    activeSecrets.push({ secret: NEW_SECRET, keyVersion: 2 });

    const body = "";
    const headers = signedHeaders({
      method: "GET",
      pathname: "/api/internal/schedules",
      caller: "scheduler",
      body,
      secret: OLD_SECRET,
    });
    const request = buildRequest({
      method: "GET",
      pathname: "/api/internal/schedules",
      headers,
    });

    const result = await authenticateInternalService(request);

    expect(result.authenticated).toBe(true);
  });

  it("rejects when the pinned key version is not present in the store", async () => {
    const { authenticateInternalService } = await import(
      "@/lib/internal-service-auth"
    );
    const body = "";
    const headers = signedHeaders({
      method: "GET",
      pathname: "/api/internal/schedules",
      caller: "scheduler",
      body,
      keyVersion: "99",
    });
    const request = buildRequest({
      method: "GET",
      pathname: "/api/internal/schedules",
      headers,
    });

    const result = await authenticateInternalService(request);

    expect(result.authenticated).toBe(false);
    expect(mockLookup).toHaveBeenCalledWith(SECRET_LOOKUP_KEY, 99);
  });

  it("rejects when no active signing secret is provisioned", async () => {
    const { authenticateInternalService } = await import(
      "@/lib/internal-service-auth"
    );
    activeSecrets.length = 0;
    const body = "";
    const headers = signedHeaders({
      method: "GET",
      pathname: "/api/internal/schedules",
      caller: "scheduler",
      body,
    });
    const request = buildRequest({
      method: "GET",
      pathname: "/api/internal/schedules",
      headers,
    });

    const result = await authenticateInternalService(request);

    expect(result).toMatchObject({
      authenticated: false,
      error: "No active signing secret",
    });
  });

  it("rejects when no auth headers are present at all", async () => {
    const { authenticateInternalService } = await import(
      "@/lib/internal-service-auth"
    );
    const request = buildRequest({
      method: "GET",
      pathname: "/api/internal/schedules",
    });

    const result = await authenticateInternalService(request);

    expect(result).toMatchObject({
      authenticated: false,
      error: "Missing auth headers",
    });
  });
});
