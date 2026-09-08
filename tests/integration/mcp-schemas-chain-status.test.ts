/**
 * Regression guard: /api/mcp/schemas must surface per-chain `status`
 * (stable / experimental / deprecated) so the `list_action_schemas` MCP
 * tool can tell agents which chains are production-ready. Without this
 * guard, a future refactor of the select map silently drops the field
 * and only manifests as a soft signal-loss in agent behaviour.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Route transitively pulls in "server-only" via dependencies; stub it
// so vitest can import the handler.
vi.mock("server-only", () => ({}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { DATABASE: "DATABASE" },
  logSystemError: vi.fn(),
}));

// Empty plugin registry keeps the test focused on the chains shape
// rather than re-asserting every plugin's action schema.
vi.mock("@/plugins/registry", () => ({
  computeActionId: vi.fn(() => "noop"),
  flattenConfigFields: vi.fn(() => []),
  getAllIntegrations: vi.fn(() => []),
}));

// db.select({...}).from(chains).leftJoin(...).where(...) -> Promise<rows>
// The route only awaits `.where(...)`, so mocking that terminal step
// covers the whole chain.
const { mockChainsWhere } = vi.hoisted(() => ({
  mockChainsWhere: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        leftJoin: vi.fn(() => ({
          where: mockChainsWhere,
        })),
      })),
    })),
  },
}));

import { GET } from "@/app/api/mcp/schemas/route";

const STABLE_ETH = {
  chain: {
    chainId: 1,
    name: "Ethereum Mainnet",
    symbol: "ETH",
    chainType: "evm",
    isTestnet: false,
    status: "stable",
  },
  explorer: { explorerUrl: "https://etherscan.io" },
};

const EXPERIMENTAL_OG_GALILEO = {
  chain: {
    chainId: 16_602,
    name: "0G Galileo",
    symbol: "0G",
    chainType: "evm",
    isTestnet: true,
    status: "experimental",
  },
  explorer: null,
};

const EXPERIMENTAL_OG = {
  chain: {
    chainId: 16_661,
    name: "0G",
    symbol: "0G",
    chainType: "evm",
    isTestnet: false,
    status: "experimental",
  },
  explorer: null,
};

function buildRequest(): Request {
  return new Request("http://localhost/api/mcp/schemas");
}

describe("GET /api/mcp/schemas - chain status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("includes a status field on every chain entry", async () => {
    mockChainsWhere.mockResolvedValue([
      STABLE_ETH,
      EXPERIMENTAL_OG,
      EXPERIMENTAL_OG_GALILEO,
    ]);

    const res = await GET(buildRequest());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { chains: Array<{ status: string }> };

    expect(body.chains).toHaveLength(3);
    for (const chain of body.chains) {
      expect(typeof chain.status).toBe("string");
      expect(chain.status.length).toBeGreaterThan(0);
    }
  });

  it("propagates the row's status value (stable / experimental) verbatim", async () => {
    mockChainsWhere.mockResolvedValue([
      STABLE_ETH,
      EXPERIMENTAL_OG,
      EXPERIMENTAL_OG_GALILEO,
    ]);

    const res = await GET(buildRequest());
    const body = (await res.json()) as {
      chains: Array<{ chainId: number; status: string }>;
    };
    const byId = new Map(body.chains.map((c) => [c.chainId, c.status]));

    expect(byId.get(1)).toBe("stable");
    expect(byId.get(16_661)).toBe("experimental");
    expect(byId.get(16_602)).toBe("experimental");
  });

  it("omits chains entirely when includeChains=false (status field is moot)", async () => {
    mockChainsWhere.mockResolvedValue([STABLE_ETH]);

    const res = await GET(
      new Request("http://localhost/api/mcp/schemas?includeChains=false")
    );
    const body = (await res.json()) as { chains: unknown[] };
    expect(body.chains).toEqual([]);
  });
});
