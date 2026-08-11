import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDbSelect = vi.fn();

vi.mock("@/lib/db", () => ({
  db: { select: mockDbSelect },
}));

vi.mock("@/lib/db/schema", () => ({
  workflows: {
    id: "id",
    name: "name",
    description: "description",
    listedSlug: "listed_slug",
    inputSchema: "input_schema",
    priceUsdcPerCall: "price_usdc_per_call",
    workflowType: "workflow_type",
    category: "category",
    chain: "chain",
    isListed: "is_listed",
  },
}));

vi.mock("@/lib/sanitize-description", () => ({
  sanitizeDescription: (s: string) => s,
}));

describe("GET /api/openapi", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_APP_URL = "https://app.keeperhub.com";
  });

  it("returns valid OpenAPI 3.1.0 structure", async () => {
    mockDbSelect.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });

    const { GET } = await import("@/app/api/openapi/route");
    const request = new Request("https://app.keeperhub.com/api/openapi");
    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.openapi).toBe("3.1.0");
    expect(body.info.title).toBe("KeeperHub");
    expect(body.servers[0].url).toBe("https://app.keeperhub.com");
  });

  it("includes x-payment-info for paid read workflows", async () => {
    mockDbSelect.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([
          {
            id: "wf-1",
            name: "Paid Workflow",
            description: "A paid workflow",
            listedSlug: "paid-workflow",
            inputSchema: {
              type: "object",
              properties: { msg: { type: "string" } },
            },
            priceUsdcPerCall: "0.05",
            workflowType: "read",
            category: "web3",
            chain: "base",
          },
        ]),
      }),
    });

    const { GET } = await import("@/app/api/openapi/route");
    const request = new Request("https://app.keeperhub.com/api/openapi");
    const response = await GET(request);
    const body = await response.json();
    const path = body.paths["/api/mcp/workflows/paid-workflow/call"];

    expect(path).toBeDefined();
    expect(path.post["x-payment-info"]).toBeDefined();
    expect(path.post["x-payment-info"].price.amount).toBe("0.05");
    expect(path.post.responses["402"]).toBeDefined();
  });

  it("declares OpenAPI security schemes for x402 and SIWX discovery clients", async () => {
    mockDbSelect.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });

    const { GET } = await import("@/app/api/openapi/route");
    const request = new Request("https://app.keeperhub.com/api/openapi");
    const response = await GET(request);
    const body = await response.json();

    expect(body.components.securitySchemes.x402).toMatchObject({
      type: "http",
      scheme: "Payment",
    });
    expect(body.components.securitySchemes.siwx).toMatchObject({
      type: "http",
      scheme: "bearer",
      bearerFormat: "CAIP-122",
    });
  });

  it("paid read workflows: no `security` (paid auth via x-payment-info → 402) + open-object fallback requestBody", async () => {
    mockDbSelect.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([
          {
            id: "wf-paid",
            name: "Paid Workflow",
            description: null,
            listedSlug: "paid-wf",
            inputSchema: null,
            priceUsdcPerCall: "0.01",
            workflowType: "read",
            category: null,
            chain: null,
          },
        ]),
      }),
    });

    const { GET } = await import("@/app/api/openapi/route");
    const request = new Request("https://app.keeperhub.com/api/openapi");
    const response = await GET(request);
    const body = await response.json();
    const op = body.paths["/api/mcp/workflows/paid-wf/call"].post;

    // Paid routes' auth mode is conveyed by x-payment-info + responses[402];
    // OpenAPI security stays unset (NOT empty) so scanners infer "paid".
    expect(op.security).toBeUndefined();
    expect(op["x-payment-info"]).toBeDefined();
    expect(op.responses["402"]).toBeDefined();
    // Paid routes without a DB-backed inputSchema get a default open-object
    // schema so discovery scanners (e.g. @agentcash/discovery) don't emit
    // L3_INPUT_SCHEMA_MISSING.
    expect(op.requestBody).toBeDefined();
    expect(op.requestBody.content["application/json"].schema).toEqual({
      type: "object",
    });
  });

  it("free read workflows: declare `security: []` (= no auth required, OpenAPI 3.x)", async () => {
    mockDbSelect.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([
          {
            id: "wf-free",
            name: "Free Workflow",
            description: null,
            listedSlug: "free-wf",
            inputSchema: null,
            priceUsdcPerCall: "0",
            workflowType: "read",
            category: null,
            chain: null,
          },
        ]),
      }),
    });

    const { GET } = await import("@/app/api/openapi/route");
    const request = new Request("https://app.keeperhub.com/api/openapi");
    const response = await GET(request);
    const body = await response.json();
    const op = body.paths["/api/mcp/workflows/free-wf/call"].post;

    // Empty array is canonical OpenAPI for "no auth"; agentcash/x402scan
    // both read this and stop emitting L2/L3_AUTH_MODE_MISSING.
    expect(op.security).toEqual([]);
    expect(op["x-payment-info"]).toBeUndefined();
    // Free read workflows with no DB-backed schema don't need a fallback
    // request body.
    expect(op.requestBody).toBeUndefined();
  });

  it("write workflows: also declare `security: []` (writes never paid at HTTP layer) + fallback requestBody", async () => {
    mockDbSelect.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([
          {
            id: "wf-write-priced",
            name: "Priced Write Workflow",
            description: null,
            listedSlug: "priced-write",
            inputSchema: null,
            priceUsdcPerCall: "0.10",
            workflowType: "write",
            category: null,
            chain: null,
          },
        ]),
      }),
    });

    const { GET } = await import("@/app/api/openapi/route");
    const request = new Request("https://app.keeperhub.com/api/openapi");
    const response = await GET(request);
    const body = await response.json();
    const op = body.paths["/api/mcp/workflows/priced-write/call"].post;

    // Write workflows with priceUsdcPerCall > 0 are still NOT paid at the
    // HTTP layer — handleWriteWorkflow returns calldata for the caller to
    // sign+broadcast (gas paid on-chain). No 402 ever fires. Security must
    // be `[]`, not unset, so the auth scanner doesn't think these are paid.
    expect(op.security).toEqual([]);
    expect(op["x-payment-info"]).toBeUndefined();
    expect(op.responses["402"]).toBeUndefined();
    expect(op["x-workflow-type"]).toBe("write");
    expect(op.requestBody).toBeDefined();
  });

  it("DB-backed inputSchema takes precedence over the open-object fallback", async () => {
    mockDbSelect.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([
          {
            id: "wf-with-schema",
            name: "Paid With Schema",
            description: null,
            listedSlug: "paid-with-schema",
            inputSchema: {
              type: "object",
              required: ["address"],
              properties: { address: { type: "string" } },
            },
            priceUsdcPerCall: "0.01",
            workflowType: "read",
            category: null,
            chain: null,
          },
        ]),
      }),
    });

    const { GET } = await import("@/app/api/openapi/route");
    const request = new Request("https://app.keeperhub.com/api/openapi");
    const response = await GET(request);
    const body = await response.json();
    const op = body.paths["/api/mcp/workflows/paid-with-schema/call"].post;

    expect(op.requestBody.required).toBe(true);
    expect(op.requestBody.content["application/json"].schema.required).toEqual([
      "address",
    ]);
  });

  it("workflows with null listedSlug are silently skipped", async () => {
    mockDbSelect.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([
          {
            id: "wf-null-slug",
            name: "No Slug",
            description: null,
            listedSlug: null,
            inputSchema: null,
            priceUsdcPerCall: "0",
            workflowType: "read",
            category: null,
            chain: null,
          },
        ]),
      }),
    });

    const { GET } = await import("@/app/api/openapi/route");
    const request = new Request("https://app.keeperhub.com/api/openapi");
    const response = await GET(request);
    const body = await response.json();

    expect(Object.keys(body.paths)).toHaveLength(0);
  });

  it("includes worked examples in info.x-guidance", async () => {
    mockDbSelect.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });

    const { GET } = await import("@/app/api/openapi/route");
    const request = new Request("https://app.keeperhub.com/api/openapi");
    const response = await GET(request);
    const body = await response.json();

    expect(body.info["x-guidance"]).toContain("Worked examples");
    expect(body.info["x-guidance"]).toContain(
      "/api/mcp/workflows/aave-v3-health-check/call"
    );
    expect(body.info["x-guidance"]).toContain('"address": "0x..."');
    // YAML/Markdown consumers expect the guidance as a real multi-line block.
    expect(body.info["x-guidance"].split("\n").length).toBeGreaterThan(10);
  });

  it("excludes x-payment-info for write workflows", async () => {
    mockDbSelect.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([
          {
            id: "wf-2",
            name: "Write Workflow",
            description: "Returns calldata",
            listedSlug: "write-workflow",
            inputSchema: null,
            priceUsdcPerCall: "0.10",
            workflowType: "write",
            category: "web3",
            chain: "base",
          },
        ]),
      }),
    });

    const { GET } = await import("@/app/api/openapi/route");
    const request = new Request("https://app.keeperhub.com/api/openapi");
    const response = await GET(request);
    const body = await response.json();
    const path = body.paths["/api/mcp/workflows/write-workflow/call"];

    expect(path.post["x-payment-info"]).toBeUndefined();
    expect(path.post["x-workflow-type"]).toBe("write");
    expect(path.post.responses["402"]).toBeUndefined();
  });
});
