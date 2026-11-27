import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/middleware/auth-helpers", () => ({
  getDualAuthContext: vi.fn(),
}));

vi.mock("@/lib/mcp/listing", () => ({
  getWorkflowExposure: vi.fn(),
  getWorkflowListingPublic: vi.fn(),
  listWorkflow: vi.fn(),
  unlistWorkflow: vi.fn(),
  updateWorkflowListing: vi.fn(),
}));

vi.mock("@/lib/security/audit-log", () => ({
  buildAuditMetadata: vi.fn().mockReturnValue({}),
  recordAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

import {
  getWorkflowExposure,
  listWorkflow,
  unlistWorkflow,
  updateWorkflowListing,
} from "@/lib/mcp/listing";
import { getDualAuthContext } from "@/lib/middleware/auth-helpers";
import { eoaWorkflowLockedMessage } from "@/lib/workflow/validation/eoa-workflow-lock";

const { POST, PATCH, DELETE } = await import(
  "@/app/api/mcp/workflows/[slug]/listing/route"
);

const EOA_STEP = {
  id: "step-1",
  type: "action",
  data: {
    type: "action",
    label: "Send",
    config: {
      actionType: "web3/write-contract",
      network: "1",
      web3Connection: "eoa",
    },
  },
};

const STORED = {
  nodes: [EOA_STEP],
  isListed: false,
  priceUsdcPerCall: "0.010000",
  inputSchema: null,
  outputMapping: null,
  visibility: "private",
};

const LISTING = { ok: true as const, listing: { listedSlug: "eoa-flow" } };

function request(method: string, body?: unknown): Request {
  return new Request("http://localhost/api/mcp/workflows/wf-1/listing", {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const params = { params: Promise.resolve({ slug: "wf-1" }) };

function auth(authMethod: "session" | "api-key"): void {
  vi.mocked(getDualAuthContext).mockResolvedValue({
    userId: "user-1",
    organizationId: "org-1",
    authMethod,
    apiKeyId: authMethod === "api-key" ? "key-1" : null,
    isAnonymous: false,
  } as never);
}

async function lockedMessage(res: Response): Promise<string | undefined> {
  const body = (await res.json()) as { invalidFields?: { message: string }[] };
  return body.invalidFields?.[0]?.message;
}

describe("MCP listing routes on a workflow with an EOA step", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getWorkflowExposure).mockResolvedValue(STORED as never);
    vi.mocked(listWorkflow).mockResolvedValue(LISTING as never);
    vi.mocked(updateWorkflowListing).mockResolvedValue(LISTING as never);
    vi.mocked(unlistWorkflow).mockResolvedValue(LISTING as never);
  });

  it("refuses list_workflow from an API key", async () => {
    auth("api-key");
    const res = await POST(request("POST", { slug: "eoa-flow" }), params);
    expect(res.status).toBe(422);
    expect(await lockedMessage(res)).toBe(
      eoaWorkflowLockedMessage(["step-1"], true)
    );
    expect(listWorkflow).not.toHaveBeenCalled();
  });

  it("lists it for an editor session", async () => {
    auth("session");
    const res = await POST(request("POST", { slug: "eoa-flow" }), params);
    expect(res.status).toBe(200);
    expect(listWorkflow).toHaveBeenCalledTimes(1);
  });

  it("refuses update_workflow_listing from an API key that changes the price", async () => {
    auth("api-key");
    const res = await PATCH(
      request("PATCH", { priceUsdcPerCall: "0.5" }),
      params
    );
    expect(res.status).toBe(422);
    expect(updateWorkflowListing).not.toHaveBeenCalled();
  });

  it("lets an API key send the same price in another form", async () => {
    auth("api-key");
    const res = await PATCH(
      request("PATCH", { priceUsdcPerCall: "0.01", category: "defi" }),
      params
    );
    expect(res.status).toBe(200);
    expect(updateWorkflowListing).toHaveBeenCalledTimes(1);
  });

  it("lets an API key unlist it", async () => {
    auth("api-key");
    const res = await DELETE(request("DELETE"), params);
    expect(res.status).toBe(200);
    expect(unlistWorkflow).toHaveBeenCalledTimes(1);
  });

  it("lets an API key list a workflow with no EOA step", async () => {
    auth("api-key");
    vi.mocked(getWorkflowExposure).mockResolvedValue({
      ...STORED,
      nodes: [],
    } as never);
    const res = await POST(request("POST", { slug: "eoa-flow" }), params);
    expect(res.status).toBe(200);
  });
});
