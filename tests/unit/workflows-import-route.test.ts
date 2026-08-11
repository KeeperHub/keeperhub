import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/auth", () => ({
  auth: {
    api: {
      getSession: vi.fn(),
    },
  },
}));

vi.mock("@/lib/middleware/auth-helpers", () => ({
  getDualAuthContext: vi
    .fn()
    .mockResolvedValue({ error: "Unauthorized", status: 401 }),
  auditFromAuth: vi.fn().mockReturnValue({}),
}));

vi.mock("@/lib/db/integrations", () => ({
  validateWorkflowIntegrations: vi.fn(),
}));

vi.mock("@/lib/metrics", () => ({
  getMetricsCollector: vi.fn().mockReturnValue({
    incrementCounter: vi.fn(),
  }),
}));

vi.mock("@/lib/metrics/types", () => ({
  MetricNames: { WORKFLOW_IMPORTS_TOTAL: "workflow_imports_total" },
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { DATABASE: "DATABASE" },
  logSystemError: vi.fn(),
}));

vi.mock("@/lib/is-anonymous", () => ({
  isAnonymousUser: vi.fn().mockReturnValue(false),
}));

vi.mock("@/lib/utils/id", () => ({
  generateId: vi.fn().mockReturnValue("wf_test_id"),
}));

vi.mock("@/lib/workflow/editor/sanitize-nodes", () => ({
  sanitizeWorkflowData: vi.fn(),
}));

import { POST } from "@/app/api/workflows/import/route";

const IMPORT_TOO_LARGE_RE = /Import too large/;

function makeRequest(headers: Record<string, string>, body = ""): Request {
  return new Request("http://localhost/api/workflows/import", {
    method: "POST",
    headers: new Headers(headers),
    body,
  });
}

describe("POST /api/workflows/import — Content-Length 413 guard (SEC-02)", () => {
  it("returns 413 when Content-Length exceeds 1 MB", async () => {
    const response = await POST(
      makeRequest({
        "content-length": "5000000",
        "content-type": "application/json",
      })
    );
    expect(response.status).toBe(413);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(IMPORT_TOO_LARGE_RE);
    expect(body.error).toContain("5000000");
    expect(body.error).toContain("1048576");
  });

  it("returns 413 at exactly 1 MB + 1 byte", async () => {
    const response = await POST(
      makeRequest({
        "content-length": "1048577",
        "content-type": "application/json",
      })
    );
    expect(response.status).toBe(413);
  });

  it("does NOT return 413 at exactly 1 MB", async () => {
    const response = await POST(
      makeRequest({
        "content-length": "1048576",
        "content-type": "application/json",
      })
    );
    expect(response.status).not.toBe(413);
  });

  it("does NOT return 413 when Content-Length header is absent", async () => {
    const response = await POST(
      makeRequest({ "content-type": "application/json" })
    );
    expect(response.status).not.toBe(413);
  });

  it("does NOT return 413 when Content-Length is unparseable", async () => {
    const response = await POST(
      makeRequest({
        "content-length": "not-a-number",
        "content-type": "application/json",
      })
    );
    expect(response.status).not.toBe(413);
  });
});
