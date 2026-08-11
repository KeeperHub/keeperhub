import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/middleware/auth-helpers", () => ({
  getDualAuthContext: vi.fn(),
}));

vi.mock("@/lib/mcp/listing", () => ({
  listWorkflow: vi.fn(),
  unlistWorkflow: vi.fn(),
  updateWorkflowListing: vi.fn(),
}));

import { updateWorkflowListing } from "@/lib/mcp/listing";
import { getDualAuthContext } from "@/lib/middleware/auth-helpers";

const { PATCH } = await import("@/app/api/mcp/workflows/[slug]/listing/route");

const makeRequest = (body: unknown) =>
  new Request("http://localhost/api/mcp/workflows/wf-123/listing", {
    method: "PATCH",
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

describe("mcp curator routes — price change guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("price change while listed: PATCH with priceUsdcPerCall on listed workflow returns 409 PRICE_CHANGE_WHILE_LISTED", async () => {
    mockAuth();
    vi.mocked(updateWorkflowListing).mockResolvedValue({
      ok: false,
      error: "PRICE_CHANGE_WHILE_LISTED",
    });

    const res = await PATCH(
      makeRequest({ priceUsdcPerCall: "2.00" }),
      makeParams()
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("PRICE_CHANGE_WHILE_LISTED");
  });

  it("price change while unlisted: PATCH with priceUsdcPerCall on unlisted workflow returns 200", async () => {
    mockAuth();
    vi.mocked(updateWorkflowListing).mockResolvedValue({
      ok: true,
      listing: {
        id: "wf-123",
        isListed: false,
        listedSlug: "my-slug",
        priceUsdcPerCall: "2.00",
      } as never,
    });

    const res = await PATCH(
      makeRequest({ priceUsdcPerCall: "2.00" }),
      makeParams()
    );
    expect(res.status).toBe(200);
  });
});
