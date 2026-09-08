import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/middleware/auth-helpers", () => ({
  getDualAuthContext: vi.fn(),
}));

vi.mock("@/lib/mcp/listing", () => ({
  getWorkflowListingPublic: vi.fn(),
  listWorkflow: vi.fn(),
  unlistWorkflow: vi.fn(),
  updateWorkflowListing: vi.fn(),
}));

import {
  getWorkflowListingPublic,
  listWorkflow,
  unlistWorkflow,
} from "@/lib/mcp/listing";
import { getDualAuthContext } from "@/lib/middleware/auth-helpers";

// Dynamic import after mocks are set up
const { GET, POST, DELETE } = await import(
  "@/app/api/mcp/workflows/[slug]/listing/route"
);

const makePostRequest = (body?: unknown) =>
  new Request("http://localhost/api/mcp/workflows/wf-123/listing", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const makeDeleteRequest = () =>
  new Request("http://localhost/api/mcp/workflows/wf-123/listing", {
    method: "DELETE",
  });

const makeGetRequest = () =>
  new Request("http://localhost/api/mcp/workflows/my-slug/listing", {
    method: "GET",
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

const mockNoAuth = () =>
  vi.mocked(getDualAuthContext).mockResolvedValue({
    error: "Unauthorized",
    code: "unauthorized",
    status: 401,
  });

describe("mcp curator tools — org-scope and auth enforcement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("org-scope 404: POST returns 404 when listing helper returns NOT_FOUND", async () => {
    mockAuth();
    vi.mocked(listWorkflow).mockResolvedValue({
      ok: false,
      error: "NOT_FOUND",
    });

    const res = await POST(
      makePostRequest({ slug: "my-workflow" }),
      makeParams()
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Workflow not found");
  });

  it("org-scope 404: DELETE returns 404 when unlist helper returns NOT_FOUND", async () => {
    mockAuth();
    vi.mocked(unlistWorkflow).mockResolvedValue({
      ok: false,
      error: "NOT_FOUND",
    });

    const res = await DELETE(makeDeleteRequest(), makeParams());
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Workflow not found");
  });

  it("unauthenticated POST returns 401", async () => {
    mockNoAuth();

    const res = await POST(
      makePostRequest({ slug: "my-workflow" }),
      makeParams()
    );
    expect(res.status).toBe(401);
  });
});

describe("mcp public listing GET — no workflow nodes leak", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("GET returns 200 with listing metadata but no `nodes` property", async () => {
    vi.mocked(getWorkflowListingPublic).mockResolvedValue({
      ok: true,
      listing: {
        id: "wf-123",
        name: "Public Workflow",
        description: null,
        listedSlug: "my-slug",
        listedAt: new Date("2026-01-01"),
        inputSchema: { type: "object" },
        outputMapping: { txHash: "result.hash" },
        priceUsdcPerCall: "0.25",
        organizationId: "org-abc",
        createdAt: new Date("2026-01-01"),
        updatedAt: new Date("2026-01-01"),
        isListed: true,
        workflowType: "read",
        category: "defi",
        chain: "base",
        listingVersion: 3,
      },
    });

    const res = await GET(makeGetRequest(), makeParams("my-slug"));
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    // The public route must call the nodes-free projection, never the full one.
    expect(getWorkflowListingPublic).toHaveBeenCalledWith("my-slug");
    // Unauthenticated callers must never receive workflow node internals.
    expect("nodes" in body).toBe(false);
    // Bazaar-facing metadata is still present.
    expect(body.inputSchema).toEqual({ type: "object" });
    expect(body.outputMapping).toEqual({ txHash: "result.hash" });
    expect(body.listingVersion).toBe(3);
  });

  it("GET returns 404 when the public projection finds no listing", async () => {
    vi.mocked(getWorkflowListingPublic).mockResolvedValue({
      ok: false,
      error: "NOT_FOUND",
    });

    const res = await GET(makeGetRequest(), makeParams("missing-slug"));
    expect(res.status).toBe(404);
  });
});
