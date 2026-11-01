import { describe, expect, it, vi } from "vitest";

const mockFindFirst = vi.fn();

vi.mock("@/lib/db", () => ({
  db: { query: { workflows: { findFirst: mockFindFirst } } },
}));

vi.mock("@/lib/middleware/auth-helpers", () => ({
  getDualAuthContext: vi.fn().mockResolvedValue({
    userId: "anon-1",
    organizationId: "org-anon",
    authMethod: "session",
    apiKeyId: null,
    isAnonymous: true,
  }),
  authFailureResponse: vi.fn(),
}));

const { PUT } = await import("@/app/api/workflows/[workflowId]/go-live/route");

describe("go-live route", () => {
  it("refuses to share a workflow for an anonymous account", async () => {
    const response = await PUT(
      new Request("http://localhost/api/workflows/wf-1/go-live", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Shared", mode: "public" }),
      }),
      { params: Promise.resolve({ workflowId: "wf-1" }) }
    );

    expect(response.status).toBe(403);
    expect(mockFindFirst).not.toHaveBeenCalled();
  });
});
