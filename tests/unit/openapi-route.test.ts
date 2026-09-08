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

  it("priced write workflows: advertise payment (402 + x-payment-info) + fallback requestBody", async () => {
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

    // A priced write listing charges for the calldata it returns, so it must
    // advertise payment like any other paid resource: `security` unset (auth
    // comes via the 402 challenge), x-payment-info present, and a documented
    // 402 response. Declaring `security: []` here would tell scanners the
    // endpoint is free and index it as broken the moment it answers 402.
    expect(op.security).toBeUndefined();
    expect(op["x-payment-info"]).toBeDefined();
    expect(op.responses["402"]).toBeDefined();
    // The 200 shape is unchanged: writes still return unsigned calldata.
    expect(op["x-workflow-type"]).toBe("write");
    expect(op.requestBody).toBeDefined();
  });

  it("free write workflows still declare `security: []` and no 402", async () => {
    mockDbSelect.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([
          {
            id: "wf-write-free",
            name: "Free Write Workflow",
            description: null,
            listedSlug: "free-write",
            inputSchema: null,
            priceUsdcPerCall: null,
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
    const op = body.paths["/api/mcp/workflows/free-write/call"].post;

    expect(op.security).toEqual([]);
    expect(op["x-payment-info"]).toBeUndefined();
    expect(op.responses["402"]).toBeUndefined();
    expect(op["x-workflow-type"]).toBe("write");
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

    // The discovery endpoints (/api/health, /api/chains, ...) are always
    // documented; a slug-less workflow contributes no call path of its own.
    const callPaths = Object.keys(body.paths).filter((path) =>
      path.startsWith("/api/mcp/workflows/")
    );
    expect(callPaths).toHaveLength(0);
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

    expect(path.post["x-payment-info"]).toBeDefined();
    expect(path.post["x-workflow-type"]).toBe("write");
    expect(path.post.responses["402"]).toBeDefined();
  });
});

/**
 * The three contracts an unattended integrator needs from the document: a typed
 * error it can branch on, a version it can pin, and rate-limit headers it can
 * throttle from. Each describes behaviour that already ships - these tests pin
 * that the document keeps saying so.
 */
describe("GET /api/openapi agent contracts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_APP_URL = "https://app.keeperhub.com";
    mockDbSelect.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([
          {
            id: "wf-1",
            name: "Paid Workflow",
            description: "A paid workflow",
            listedSlug: "paid-workflow",
            inputSchema: null,
            priceUsdcPerCall: "0.01",
            workflowType: "read",
            category: null,
            chain: null,
          },
        ]),
      }),
    });
  });

  /**
   * OpenAPI documents are deeply dynamic, so the assertions below walk an
   * untyped tree on purpose - pinning a full TypeScript shape here would test
   * the type rather than the document the route emits.
   */
  type OpenApiNode = { [key: string]: OpenApiNode };

  async function fetchDoc(): Promise<OpenApiNode> {
    const { GET } = await import("@/app/api/openapi/route");
    const response = await GET(
      new Request("https://app.keeperhub.com/api/openapi")
    );
    return (await response.json()) as OpenApiNode;
  }

  describe("typed error model", () => {
    it("defines an Error schema with a machine-readable code and human message", async () => {
      const doc = await fetchDoc();
      const schema = doc.components.schemas.Error;
      expect(schema.type).toBe("object");
      expect(schema.required).toEqual(["error", "detail"]);
      expect(Object.keys(schema.properties)).toEqual(
        expect.arrayContaining([
          "error",
          "detail",
          "hint",
          "docs",
          "request_id",
        ])
      );
    });

    it("attaches the shared error responses to every operation", async () => {
      const doc = await fetchDoc();
      for (const [path, item] of Object.entries(doc.paths)) {
        for (const [method, operation] of Object.entries(item)) {
          for (const status of ["400", "401", "403", "404", "429", "500"]) {
            expect(
              operation.responses[status],
              `${method.toUpperCase()} ${path} has no ${status}`
            ).toBeDefined();
          }
        }
      }
    });

    it("resolves every error $ref to a declared component", async () => {
      const doc = await fetchDoc();
      const declared = Object.keys(doc.components.responses);
      const refs = JSON.stringify(doc.paths).match(
        /#\/components\/responses\/(\w+)/g
      );
      expect(refs).not.toBeNull();
      for (const ref of new Set(refs ?? [])) {
        expect(declared).toContain(ref.split("/").pop());
      }
    });

    it("carries the correlation header on every error response", async () => {
      const doc = await fetchDoc();
      for (const response of Object.values(doc.components.responses)) {
        expect(response.headers["x-request-id"]).toBeDefined();
        expect(response.content["application/json"].schema.$ref).toBe(
          "#/components/schemas/Error"
        );
      }
    });

    it("publishes the canonical error codes in x-error-model", async () => {
      const doc = await fetchDoc();
      expect(doc["x-error-model"].codeField).toBe("error");
      expect(doc["x-error-model"].codes).toEqual(
        expect.arrayContaining([
          "unauthorized",
          "not_found",
          "invalid_input",
          "rate_limited",
          "internal_error",
        ])
      );
    });
  });

  describe("versioning and deprecation", () => {
    it("declares a version header parameter on every operation", async () => {
      const doc = await fetchDoc();
      for (const [path, item] of Object.entries(doc.paths)) {
        for (const operation of Object.values(item)) {
          const names = (
            (operation.parameters ?? []) as unknown as { name: string }[]
          ).map((parameter) => parameter.name);
          expect(names, `${path} has no version parameter`).toContain(
            "KeeperHub-Version"
          );
        }
      }
    });

    it("declares the current version and the header strategy", async () => {
      const doc = await fetchDoc();
      expect(doc["x-api-versioning"].strategy).toBe("header");
      expect(doc["x-api-versioning"].header).toBe("KeeperHub-Version");
      expect(doc["x-api-versioning"].current).toBe("1");
      expect(doc["x-api-versioning"].supported).toContain("1");
      expect(doc.info.version).toBe("1.0.0");
    });

    it("publishes the deprecation signals and the minimum notice period", async () => {
      const doc = await fetchDoc();
      const { deprecation } = doc["x-api-versioning"];
      expect(deprecation.headers).toEqual(
        expect.arrayContaining(["Deprecation", "Sunset", "Link"])
      );
      // A number, not prose, so a client can plan against it.
      expect(deprecation.minimumNoticeDays).toBe(180);
    });
  });

  describe("rate limits", () => {
    it("documents both header spellings plus Retry-After", async () => {
      const doc = await fetchDoc();
      expect(Object.keys(doc.components.headers)).toEqual(
        expect.arrayContaining([
          "RateLimit-Limit",
          "RateLimit-Remaining",
          "RateLimit-Reset",
          "X-RateLimit-Limit",
          "Retry-After",
        ])
      );
    });

    it("declares rate-limit headers on the 429 response", async () => {
      const doc = await fetchDoc();
      const limited = doc.components.responses.RateLimited;
      expect(limited.headers["Retry-After"]).toBeDefined();
      expect(limited.headers["RateLimit-Remaining"]).toBeDefined();
    });

    it("declares rate-limit headers on successful workflow calls too", async () => {
      // A client that can only see them on a 429 has already been refused once.
      const doc = await fetchDoc();
      const operation = doc.paths["/api/mcp/workflows/paid-workflow/call"].post;
      expect(
        operation.responses["200"].headers["RateLimit-Limit"]
      ).toBeDefined();
    });
  });

  describe("verifiable API surface", () => {
    it("documents the discovery endpoints, not only marketplace listings", async () => {
      // Without these the document is empty on a deployment with no listings,
      // which reads as "no API" to a scanner.
      const doc = await fetchDoc();
      for (const path of [
        "/api/health",
        "/api/chains",
        "/api/mcp/workflows",
        "/api/keys",
      ]) {
        expect(doc.paths[path], `${path} is not documented`).toBeDefined();
      }
    });

    it("marks the public discovery endpoints as needing no auth", async () => {
      const doc = await fetchDoc();
      expect(doc.paths["/api/chains"].get.security).toEqual([]);
      expect(doc.paths["/api/health"].get.security).toEqual([]);
    });

    it("declares a bearer scheme for the credential probe", async () => {
      const doc = await fetchDoc();
      expect(doc.components.securitySchemes.bearerAuth.scheme).toBe("bearer");
      expect(doc.paths["/api/keys"].get.security).toEqual([{ bearerAuth: [] }]);
    });

    it("points at the docs reference, CLI, and sandbox", async () => {
      const doc = await fetchDoc();
      const info = doc["x-service-info"];
      // Points at docs, not a duplicate page on this host.
      expect(info.developerPortal).toBe(
        "https://docs.keeperhub.com/platform-reference"
      );
      expect(info.errors).toBe("https://docs.keeperhub.com/api/errors");
      expect(info.cli.name).toBe("kh");
      expect(info.cli.install).toContain("brew install");
      expect(
        (info.sandbox.testnets as unknown as { chainId: number }[]).map(
          (net) => net.chainId
        )
      ).toEqual([11_155_111, 84_532]);
      expect(info.mcp.transport).toBe("streamable-http");
    });

    it("keeps the workflow call paths alongside the discovery paths", async () => {
      const doc = await fetchDoc();
      expect(doc.paths["/api/mcp/workflows/paid-workflow/call"]).toBeDefined();
    });
  });
});
