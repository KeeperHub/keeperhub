/**
 * Unit tests for POST /api/feedback feature-flag gate.
 *
 * The user feedback widget is disabled by default. The route must
 * short-circuit with 503 and never proxy to the external feedback service
 * unless NEXT_PUBLIC_FEEDBACK_ENABLED === "true". Re-enabling the flag
 * restores the proxy behaviour (proving the change is reversible).
 *
 * FEEDBACK_ENABLED / FEEDBACK_SERVICE_URL / FEEDBACK_API_KEY are read into
 * module-level consts at import time, so each case stubs env then
 * re-imports the route via vi.resetModules() + dynamic import.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `@/lib/logging` declares `import "server-only"` transitively, which throws
// under vitest unless stubbed.
vi.mock("server-only", () => ({}));

vi.mock("@/lib/auth", () => ({
  auth: {
    api: {
      getSession: vi.fn().mockResolvedValue(null),
    },
  },
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: {
    INFRASTRUCTURE: "infrastructure",
    EXTERNAL_SERVICE: "external_service",
  },
  logSystemError: vi.fn(),
}));

function loadRoute(): Promise<typeof import("@/app/api/feedback/route")> {
  vi.resetModules();
  return import("@/app/api/feedback/route");
}

describe("POST /api/feedback feature-flag gate", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 })
      );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("returns 503 and does not call the external service when disabled (default)", async () => {
    vi.stubEnv("NEXT_PUBLIC_FEEDBACK_ENABLED", "");
    vi.stubEnv("FEEDBACK_SERVICE_URL", "https://feedback.example.com");
    vi.stubEnv("FEEDBACK_API_KEY", "secret");

    const { POST } = await loadRoute();
    const form = new FormData();
    form.append("message", "this should never be forwarded");
    const res = await POST(
      new Request("http://localhost/api/feedback", {
        method: "POST",
        body: form,
      })
    );

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      error: "Feedback service is disabled",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('treats any value other than the literal "true" as disabled', async () => {
    vi.stubEnv("NEXT_PUBLIC_FEEDBACK_ENABLED", "1");
    vi.stubEnv("FEEDBACK_SERVICE_URL", "https://feedback.example.com");
    vi.stubEnv("FEEDBACK_API_KEY", "secret");

    const { POST } = await loadRoute();
    const form = new FormData();
    form.append("message", "still disabled");
    const res = await POST(
      new Request("http://localhost/api/feedback", {
        method: "POST",
        body: form,
      })
    );

    expect(res.status).toBe(503);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("proxies to the external service when re-enabled via the flag", async () => {
    vi.stubEnv("NEXT_PUBLIC_FEEDBACK_ENABLED", "true");
    vi.stubEnv("FEEDBACK_SERVICE_URL", "https://feedback.example.com");
    vi.stubEnv("FEEDBACK_API_KEY", "secret");

    const { POST } = await loadRoute();
    const form = new FormData();
    form.append("message", "forward me");
    const res = await POST(
      new Request("http://localhost/api/feedback", {
        method: "POST",
        body: form,
      })
    );

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://feedback.example.com",
      expect.objectContaining({ method: "POST" })
    );
  });
});
