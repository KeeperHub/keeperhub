import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PROD_APP_URL = "https://app.keeperhub.com";

const { mockDbSelect } = vi.hoisted(() => ({
  mockDbSelect: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: mockDbSelect,
  },
}));

vi.mock("@/lib/db/schema", () => ({
  agentRegistrations: {
    id: "id",
    chainId: "chain_id",
    registryAddress: "registry_address",
  },
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { DATABASE: "DATABASE" },
  logSystemError: vi.fn(),
}));

describe("GET /api/agent-registry", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    // Endpoints are derived from the deployment's own URL rather than a
    // hardcoded app.keeperhub.com, so the tests below pin that URL to the
    // production value. That keeps them asserting exactly the payload
    // production serves, while a deployment on another domain gets its own.
    process.env = { ...originalEnv, NEXT_PUBLIC_APP_URL: PROD_APP_URL };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  function setupDbMock(rows: unknown[]) {
    mockDbSelect.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(rows),
        }),
      }),
    });
  }

  it("Test 1: returns type field matching ERC-8004 registration-v1", async () => {
    setupDbMock([]);
    const { GET } = await import("@/app/api/agent-registry/route");
    const request = new Request("http://localhost:3000/api/agent-registry");
    const response = await GET(request);
    const json = await response.json();
    expect(json.type).toBe(
      "https://eips.ethereum.org/EIPS/eip-8004#registration-v1"
    );
  });

  it("Test 2: returns name KeeperHub and description matching platform description", async () => {
    setupDbMock([]);
    const { GET } = await import("@/app/api/agent-registry/route");
    const request = new Request("http://localhost:3000/api/agent-registry");
    const response = await GET(request);
    const json = await response.json();
    expect(json.name).toBe("KeeperHub");
    expect(typeof json.description).toBe("string");
    expect(json.description.length).toBeGreaterThan(10);
  });

  it("Test 3: returns image URL for keeperhub_logo.png", async () => {
    setupDbMock([]);
    const { GET } = await import("@/app/api/agent-registry/route");
    const request = new Request("http://localhost:3000/api/agent-registry");
    const response = await GET(request);
    const json = await response.json();
    expect(json.image).toBe("https://app.keeperhub.com/keeperhub_logo.png");
  });

  it("Test 4: returns services array with MCP, A2A, web, ens, workflows, and agentWallet entries", async () => {
    setupDbMock([]);
    const { GET } = await import("@/app/api/agent-registry/route");
    const request = new Request("http://localhost:3000/api/agent-registry");
    const response = await GET(request);
    const json = await response.json();
    expect(Array.isArray(json.services)).toBe(true);
    expect(json.services).toHaveLength(6);
    const serviceNames = json.services.map((s: { name: string }) => s.name);
    expect(serviceNames).toContain("MCP");
    expect(serviceNames).toContain("A2A");
    expect(serviceNames).toContain("workflows");
    expect(serviceNames).toContain("web");
    expect(serviceNames).toContain("ens");
    expect(serviceNames).toContain("agentWallet");
    const mcpService = json.services.find(
      (s: { name: string; endpoint: string }) => s.name === "MCP"
    );
    expect(mcpService?.endpoint).toBe(
      "https://app.keeperhub.com/.well-known/mcp.json"
    );
    const a2aService = json.services.find(
      (s: { name: string; endpoint: string }) => s.name === "A2A"
    );
    expect(a2aService?.endpoint).toBe(
      "https://app.keeperhub.com/.well-known/agent-card.json"
    );
    const webService = json.services.find(
      (s: { name: string; endpoint: string }) => s.name === "web"
    );
    expect(webService?.endpoint).toBe("https://app.keeperhub.com");
    const ensService = json.services.find(
      (s: { name: string; endpoint: string }) => s.name === "ens"
    );
    expect(ensService?.endpoint).toBe("keeperhub.eth");
    const agentWalletService = json.services.find(
      (s: { name: string; endpoint: string }) => s.name === "agentWallet"
    );
    expect(agentWalletService?.endpoint).toBe(
      "eip155:1:0xaa70faa583c0889164cfd9b45aa075f6c4388fee"
    );
  });

  it("Test 4a: MCP service has version 2025-06-18 and inlines tool list", async () => {
    setupDbMock([]);
    const { GET } = await import("@/app/api/agent-registry/route");
    const request = new Request("http://localhost:3000/api/agent-registry");
    const response = await GET(request);
    const json = await response.json();
    const mcpService = json.services.find(
      (s: { name: string; version?: string; mcpTools?: string[] }) =>
        s.name === "MCP"
    );
    expect(mcpService?.version).toBe("2025-06-18");
    expect(Array.isArray(mcpService?.mcpTools)).toBe(true);
    expect(mcpService?.mcpTools?.length ?? 0).toBeGreaterThan(0);
    expect(mcpService?.mcpTools).toContain("list_workflows");
    expect(mcpService?.mcpTools).toContain("call_workflow");
  });

  it("Test 4e: A2A service has version 0.3.0", async () => {
    setupDbMock([]);
    const { GET } = await import("@/app/api/agent-registry/route");
    const request = new Request("http://localhost:3000/api/agent-registry");
    const response = await GET(request);
    const json = await response.json();
    const a2aService = json.services.find(
      (s: { name: string; version?: string }) => s.name === "A2A"
    );
    expect(a2aService?.version).toBe("0.3.0");
  });

  it("Test 4b: top-level supportedTrust equals [reputation]", async () => {
    setupDbMock([]);
    const { GET } = await import("@/app/api/agent-registry/route");
    const request = new Request("http://localhost:3000/api/agent-registry");
    const response = await GET(request);
    const json = await response.json();
    expect(json.supportedTrust).toEqual(["reputation"]);
  });

  it("Test 4c: updatedAt equals registeredAt unix seconds when a registration row exists", async () => {
    const registeredAt = new Date("2025-03-15T12:00:00Z");
    setupDbMock([
      {
        id: "test-id",
        agentId: "42",
        txHash: "0xabc123",
        registeredAt,
        chainId: 1,
        registryAddress: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
      },
    ]);
    const { GET } = await import("@/app/api/agent-registry/route");
    const request = new Request("http://localhost:3000/api/agent-registry");
    const response = await GET(request);
    const json = await response.json();
    expect(json.updatedAt).toBe(Math.floor(registeredAt.getTime() / 1000));
  });

  it("Test 4d: updatedAt falls back to a recent Date.now()-derived value when no row exists", async () => {
    setupDbMock([]);
    const before = Math.floor(Date.now() / 1000);
    const { GET } = await import("@/app/api/agent-registry/route");
    const request = new Request("http://localhost:3000/api/agent-registry");
    const response = await GET(request);
    const after = Math.floor(Date.now() / 1000);
    const json = await response.json();
    expect(typeof json.updatedAt).toBe("number");
    expect(Number.isFinite(json.updatedAt)).toBe(true);
    expect(json.updatedAt).toBeGreaterThanOrEqual(before);
    expect(json.updatedAt).toBeLessThanOrEqual(after);
  });

  it("Test 5: returns x402Support: true and active: true", async () => {
    setupDbMock([]);
    const { GET } = await import("@/app/api/agent-registry/route");
    const request = new Request("http://localhost:3000/api/agent-registry");
    const response = await GET(request);
    const json = await response.json();
    expect(json.x402Support).toBe(true);
    expect(json.active).toBe(true);
  });

  it("Test 6: when DB has a registration row, returns registrations array with agentId and agentRegistry CAIP-10", async () => {
    setupDbMock([
      {
        id: "test-id",
        agentId: "42",
        txHash: "0xabc123",
        registeredAt: new Date(),
        chainId: 1,
        registryAddress: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
      },
    ]);
    const { GET } = await import("@/app/api/agent-registry/route");
    const request = new Request("http://localhost:3000/api/agent-registry");
    const response = await GET(request);
    const json = await response.json();
    expect(Array.isArray(json.registrations)).toBe(true);
    expect(json.registrations).toHaveLength(1);
    expect(json.registrations[0].agentId).toBe("42");
    expect(json.registrations[0].agentRegistry).toBe(
      "eip155:1:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432"
    );
  });

  it("Test 7: when DB has no registration rows, returns registrations: []", async () => {
    setupDbMock([]);
    const { GET } = await import("@/app/api/agent-registry/route");
    const request = new Request("http://localhost:3000/api/agent-registry");
    const response = await GET(request);
    const json = await response.json();
    expect(json.registrations).toEqual([]);
  });

  it("Test 8: response has Cache-Control header with max-age=300", async () => {
    setupDbMock([]);
    const { GET } = await import("@/app/api/agent-registry/route");
    const request = new Request("http://localhost:3000/api/agent-registry");
    const response = await GET(request);
    const cacheControl = response.headers.get("Cache-Control");
    expect(cacheControl).toContain("max-age=300");
    expect(cacheControl).toContain("public");
  });

  // A deployment that renamed itself must not keep publishing KeeperHub's ENS
  // name and agent wallet: a card carrying our wallet under someone else's name
  // is worse than one without it, because a reader would act on it.
  describe("when the deployment is not KeeperHub", () => {
    it("uses its own name and withholds the KeeperHub-only services", async () => {
      process.env = {
        ...process.env,
        AGENT_NAME: "Acme Automations",
        NEXT_PUBLIC_APP_URL: "https://kh.acme.example",
      };
      vi.resetModules();
      setupDbMock([]);
      const { GET } = await import("@/app/api/agent-registry/route");
      const response = await GET(
        new Request("https://kh.acme.example/api/agent-registry")
      );
      const json = await response.json();

      expect(json.name).toBe("Acme Automations");
      const names = json.services.map((svc: { name: string }) => svc.name);
      expect(names).not.toContain("ens");
      expect(names).not.toContain("agentWallet");
      for (const svc of json.services as { endpoint: string }[]) {
        expect(svc.endpoint).not.toContain("keeperhub.com");
      }
      expect(json.image).not.toContain("keeperhub.com");
    });
  });
});
