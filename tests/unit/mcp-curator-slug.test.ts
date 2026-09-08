import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/middleware/auth-helpers", () => ({
  getDualAuthContext: vi.fn(),
}));

vi.mock("@/lib/mcp/listing", () => ({
  listWorkflow: vi.fn(),
  unlistWorkflow: vi.fn(),
  updateWorkflowListing: vi.fn(),
}));

import { listWorkflow, updateWorkflowListing } from "@/lib/mcp/listing";
import { getDualAuthContext } from "@/lib/middleware/auth-helpers";

const { POST, PATCH } = await import(
  "@/app/api/mcp/workflows/[slug]/listing/route"
);

const makeRequest = (body: unknown, method = "POST") =>
  new Request("http://localhost/api/mcp/workflows/wf-123/listing", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const makeParams = (id = "wf-123") => ({
  params: Promise.resolve({ slug: id }),
});

const mockAuth = (orgId = "org-abc") =>
  vi.mocked(getDualAuthContext).mockResolvedValue({
    userId: "user-1",
    organizationId: orgId,
    authMethod: "session" as const,
    apiKeyId: null,
    isAnonymous: false,
  });

describe("mcp curator routes — slug collision and preservation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("slug collision: POST with duplicate slug returns 409 with SLUG_CONFLICT error code", async () => {
    mockAuth();
    vi.mocked(listWorkflow).mockResolvedValue({
      ok: false,
      error: "SLUG_CONFLICT",
    });

    const res = await POST(makeRequest({ slug: "taken-slug" }), makeParams());
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("SLUG_CONFLICT");
  });

  it("PATCH without slug in body calls updateWorkflowListing, not listWorkflow", async () => {
    mockAuth();
    vi.mocked(updateWorkflowListing).mockResolvedValue({
      ok: true,
      listing: {
        id: "wf-123",
        isListed: true,
        listedSlug: "existing-slug",
      } as never,
    });

    const res = await PATCH(
      makeRequest({ category: "defi" }, "PATCH"),
      makeParams()
    );
    expect(res.status).toBe(200);
    expect(updateWorkflowListing).toHaveBeenCalledWith(
      "wf-123",
      "org-abc",
      expect.objectContaining({ category: "defi" })
    );
    expect(listWorkflow).not.toHaveBeenCalled();
  });
});
