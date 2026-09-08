import { describe, expect, it, vi } from "vitest";

vi.mock("@x402/next", () => ({ withX402: vi.fn() }));
vi.mock("@/lib/payments/x402/payment-gate", () => ({
  buildPaymentConfig: vi.fn(),
  extractPayerAddress: vi.fn(),
  findExistingPayment: vi.fn(),
  hashPaymentSignature: vi.fn(),
}));
vi.mock("@/lib/payments/x402/server", () => ({ server: {} }));
vi.mock("@/lib/payments/x402/reconcile", () => ({
  isTimeoutError: vi.fn(),
  pollForPaymentConfirmation: vi.fn(),
}));
vi.mock("@/lib/payments/mpp/server", () => ({
  extractMppPayerAddress: vi.fn(),
  hashMppCredential: vi.fn(),
  getMppServer: vi.fn(),
}));

vi.mock("mppx", () => ({
  Challenge: {
    from: vi.fn().mockReturnValue({
      id: "test-id",
      realm: "test",
      method: "tempo",
      intent: "charge",
      expires: "2099-01-01T00:00:00.000Z",
      request: {},
    }),
    serialize: vi
      .fn()
      .mockReturnValue(
        'Payment id="test-id", realm="test", method="tempo", intent="charge", request="eyJ9"'
      ),
  },
  Credential: {
    fromRequest: vi.fn().mockReturnValue({ source: null }),
  },
  Expires: {
    minutes: vi.fn().mockReturnValue("2099-01-01T00:00:00.000Z"),
  },
}));

import { Challenge, Expires } from "mppx";
import { buildDual402Response, detectProtocol } from "@/lib/payments/router";

describe("detectProtocol", () => {
  it("returns 'mpp' when Authorization: Payment header is present", () => {
    const req = new Request("http://localhost", {
      headers: { Authorization: "Payment eyJjaGFsbGVuZ2UiOnt9fQ" },
    });
    expect(detectProtocol(req)).toBe("mpp");
  });

  it("returns 'x402' when PAYMENT-SIGNATURE header is present", () => {
    const req = new Request("http://localhost", {
      headers: { "PAYMENT-SIGNATURE": "base64sig" },
    });
    expect(detectProtocol(req)).toBe("x402");
  });

  it("returns null when no payment headers are present", () => {
    const req = new Request("http://localhost");
    expect(detectProtocol(req)).toBeNull();
  });

  it("returns 'error' when both headers are present", () => {
    const req = new Request("http://localhost", {
      headers: {
        Authorization: "Payment eyJ...",
        "PAYMENT-SIGNATURE": "base64sig",
      },
    });
    expect(detectProtocol(req)).toBe("error");
  });

  it("ignores Authorization headers that are not Payment scheme", () => {
    const req = new Request("http://localhost", {
      headers: { Authorization: "Bearer token123" },
    });
    expect(detectProtocol(req)).toBeNull();
  });
});

describe("buildDual402Response", () => {
  it("returns a 402 response", () => {
    const response = buildDual402Response({
      price: "0.01",
      creatorWalletAddress: "0xCreator",
      workflowName: "Test Workflow",
      resourceUrl: "https://example.com/api/mcp/workflows/test/call",
    });
    expect(response.status).toBe(402);
  });

  it("includes CORS headers", () => {
    const response = buildDual402Response({
      price: "0.01",
      creatorWalletAddress: "0xCreator",
      workflowName: "Test Workflow",
      resourceUrl: "https://example.com/api/mcp/workflows/test/call",
    });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("includes WWW-Authenticate header when MPP_SECRET_KEY is set", () => {
    process.env.MPP_SECRET_KEY = "test-secret";
    try {
      const response = buildDual402Response({
        price: "0.01",
        creatorWalletAddress: "0xCreator",
        workflowName: "Test Workflow",
        resourceUrl: "https://example.com/api/mcp/workflows/test/call",
      });
      const wwwAuth = response.headers.get("WWW-Authenticate");
      expect(wwwAuth).toBeTruthy();
      expect(wwwAuth).toContain("Payment");
      expect(wwwAuth).toContain("tempo");
      expect(wwwAuth).toContain("charge");
    } finally {
      delete process.env.MPP_SECRET_KEY;
    }
  });

  it("passes expires to Challenge.from", () => {
    process.env.MPP_SECRET_KEY = "test-secret";
    try {
      buildDual402Response({
        price: "0.01",
        creatorWalletAddress: "0xCreator",
        workflowName: "Test Workflow",
        resourceUrl: "https://example.com/api/mcp/workflows/test/call",
      });
      expect(Expires.minutes).toHaveBeenCalledWith(5);
      expect(Challenge.from).toHaveBeenCalledWith(
        expect.objectContaining({
          expires: "2099-01-01T00:00:00.000Z",
        })
      );
    } finally {
      delete process.env.MPP_SECRET_KEY;
    }
  });

  it("passes methodDetails.chainId to Challenge.from for Tempo pinned-field parity", () => {
    process.env.MPP_SECRET_KEY = "test-secret";
    try {
      buildDual402Response({
        price: "0.01",
        creatorWalletAddress: "0xCreator",
        workflowName: "Test Workflow",
        resourceUrl: "https://example.com/api/mcp/workflows/test/call",
      });
      expect(Challenge.from).toHaveBeenCalledWith(
        expect.objectContaining({
          request: expect.objectContaining({
            amount: "10000",
            methodDetails: { chainId: 4217 },
          }),
        })
      );
    } finally {
      delete process.env.MPP_SECRET_KEY;
    }
  });

  it("omits WWW-Authenticate header when MPP_SECRET_KEY is not set", () => {
    delete process.env.MPP_SECRET_KEY;
    const response = buildDual402Response({
      price: "0.01",
      creatorWalletAddress: "0xCreator",
      workflowName: "Test Workflow",
      resourceUrl: "https://example.com/api/mcp/workflows/test/call",
    });
    expect(response.headers.get("WWW-Authenticate")).toBeNull();
  });

  it("emits the canonical PAYMENT-REQUIRED header with x402 v2 shape", async () => {
    const response = buildDual402Response({
      price: "0.01",
      creatorWalletAddress: "0xCreator",
      workflowName: "Test Workflow",
      resourceUrl: "https://example.com/api/mcp/workflows/test/call",
    });
    const header = response.headers.get("PAYMENT-REQUIRED");
    expect(header).toBeTruthy();
    const decoded = JSON.parse(
      Buffer.from(header as string, "base64").toString("utf8")
    );
    expect(decoded.x402Version).toBe(2);
    expect(decoded.error).toBe("Payment required");
    expect(decoded.resource).toEqual({
      url: "https://example.com/api/mcp/workflows/test/call",
      description: "Pay to run workflow: Test Workflow",
      mimeType: "application/json",
    });
    expect(Array.isArray(decoded.accepts)).toBe(true);
    expect(decoded.accepts).toHaveLength(1);
    expect(decoded.accepts[0]).toEqual({
      scheme: "exact",
      network: "eip155:8453",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      amount: "10000",
      payTo: "0xCreator",
      maxTimeoutSeconds: 300,
      extra: { name: "USD Coin", version: "2" },
    });
    // Body mirrors the header payload so probers that read the body still
    // see the canonical shape.
    const body = await response.json();
    expect(body).toEqual(decoded);
  });

  it("also emits X-PAYMENT-REQUIREMENTS as a legacy alias with the same payload", () => {
    const response = buildDual402Response({
      price: "0.01",
      creatorWalletAddress: "0xCreator",
      workflowName: "Test Workflow",
      resourceUrl: "https://example.com/api/mcp/workflows/test/call",
    });
    expect(response.headers.get("X-PAYMENT-REQUIREMENTS")).toBe(
      response.headers.get("PAYMENT-REQUIRED")
    );
  });

  it("embeds extensions.bazaar.schema at the path agentcash probes when inputSchema is present", async () => {
    const inputSchema = {
      type: "object",
      required: ["address"],
      properties: {
        address: { type: "string", description: "eth address" },
      },
    };
    const response = buildDual402Response({
      price: "0.01",
      creatorWalletAddress: "0xCreator",
      workflowName: "Test Workflow",
      resourceUrl: "https://example.com/api/mcp/workflows/test/call",
      inputSchema,
    });
    const body = await response.json();
    // Agentcash's extractSchemas2 drills
    // extensions.bazaar.schema.properties.input.properties.body and
    // extensions.bazaar.schema.properties.output.properties.example -- see
    // @agentcash/discovery dist/index.js extractSchemas2.
    expect(
      body.extensions.bazaar.schema.properties.input.properties.body
    ).toEqual(inputSchema);
    expect(
      body.extensions.bazaar.schema.properties.output.properties.example
    ).toEqual({ executionId: "exec_abc123", status: "running" });
  });

  it("always emits extensions.bazaar.discoverable:true so CDP Bazaar indexes the resource", async () => {
    const response = buildDual402Response({
      price: "0.01",
      creatorWalletAddress: "0xCreator",
      workflowName: "Test Workflow",
      resourceUrl: "https://example.com/api/mcp/workflows/test/call",
    });
    const body = await response.json();
    expect(body.extensions.bazaar.discoverable).toBe(true);
    expect(body.extensions.bazaar.category).toBeUndefined();
    expect(body.extensions.bazaar.tags).toBeUndefined();
  });

  it("emits extensions.bazaar.schema with an open-object body fallback when inputSchema is missing", async () => {
    const response = buildDual402Response({
      price: "0.01",
      creatorWalletAddress: "0xCreator",
      workflowName: "Workflow With No DB Schema",
      resourceUrl: "https://example.com/api/mcp/workflows/no-schema/call",
    });
    const body = await response.json();
    // Without this fallback, @agentcash/discovery's getWarningsFor402Body
    // emits SCHEMA_INPUT_MISSING / SCHEMA_OUTPUT_MISSING for the resource
    // and CDP Bazaar can't index it.
    expect(
      body.extensions.bazaar.schema.properties.input.properties.body
    ).toEqual({
      type: "object",
    });
    expect(
      body.extensions.bazaar.schema.properties.output.properties.example
    ).toEqual({ executionId: "exec_abc123", status: "running" });
  });

  it("emits extensions.bazaar.category and tags when provided", async () => {
    const response = buildDual402Response({
      price: "0.01",
      creatorWalletAddress: "0xCreator",
      workflowName: "Test Workflow",
      resourceUrl: "https://example.com/api/mcp/workflows/test/call",
      category: "web3",
      tagName: "defi",
    });
    const body = await response.json();
    expect(body.extensions.bazaar.discoverable).toBe(true);
    expect(body.extensions.bazaar.category).toBe("web3");
    expect(body.extensions.bazaar.tags).toEqual(["defi"]);
  });
});

describe("402 challenge output example", () => {
  it("advertises the calldata shape for a write listing", async () => {
    const { buildDual402Response } = await import("@/lib/payments/router");
    const response = buildDual402Response({
      price: "0.05",
      creatorWalletAddress: "0xCreator",
      workflowName: "Priced Write Workflow",
      resourceUrl: "https://example.com/api/mcp/workflows/priced-write/call",
      workflowType: "write",
    });
    const body = await response.json();

    // A write listing starts no execution, so advertising the executionId
    // shape would point Bazaar / x402scan at a poll target that never comes.
    expect(
      body.extensions.bazaar.schema.properties.output.properties.example
    ).toEqual({
      type: "calldata",
      to: "0x0000000000000000000000000000000000000000",
      data: "0xa9059cbb",
      value: "0",
    });
  });
});
