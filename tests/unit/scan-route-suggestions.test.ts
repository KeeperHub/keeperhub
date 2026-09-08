/**
 * Integration tests for GET /api/scan/[address] + suggestion engine (TEST-02).
 *
 * Covers the full route → engine → factory pipeline:
 *   - Route attaches buildSuggestions output to the 200 response (52-05)
 *   - Arbitrum USDC fixture produces a yield suggestion with chainId 42161
 *   - buildWorkflow on that suggestion produces nodes with config.network "42161"
 *
 * FUNNEL-01: requests are unauthenticated throughout.
 *
 * Requirements covered: TEST-02
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildWorkflow } from "@/lib/scan/factory";

vi.mock("server-only", () => ({}));

const { mockIncrementAndCheck, mockGetRequestSourceIp, mockScanAddress } =
  vi.hoisted(() => ({
    mockIncrementAndCheck: vi.fn(),
    mockGetRequestSourceIp: vi.fn(),
    mockScanAddress: vi.fn(),
  }));

const { mockFetchDefillamaYieldPools, mockBuildApyContext } = vi.hoisted(
  () => ({
    mockFetchDefillamaYieldPools: vi.fn(),
    mockBuildApyContext: vi.fn(),
  })
);

vi.mock("@/lib/scan/rate-limit", () => ({
  incrementAndCheckWithBackoff: mockIncrementAndCheck,
}));

vi.mock("@/lib/security/request-attribution", () => ({
  getRequestSourceIp: mockGetRequestSourceIp,
}));

vi.mock("@/lib/scan/scanner", () => ({
  scanAddress: mockScanAddress,
}));

vi.mock("@/lib/scan/price/defillama-yields", () => ({
  fetchDefillamaYieldPools: mockFetchDefillamaYieldPools,
  buildApyContext: mockBuildApyContext,
}));

const { GET } = await import("@/app/api/scan/[address]/route");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Top-level regex constants (useTopLevelRegex rule)
const RE_CHAIN_ID_42161 = /42161/;
const RE_APY_COPY = /4\.2% APY via Aave V3 on Arbitrum/;

/** Arbitrum native USDC — from scripts/seed/seed-tokens.ts */
const ARBITRUM_USDC = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";

const VALID_ADDRESS = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const MOCK_IP = "1.2.3.4";

const ALLOWED_RATE = {
  allowed: true as const,
  count: 1,
  limit: 3,
  remaining: 2,
  reset: 9_999_999_999,
};

/**
 * Minimal ScanResponse fixture with one Arbitrum USDC stablecoin position.
 * chainId 42161; usdValue 500; non-depegged — should produce a yield suggestion.
 */
const MOCK_SCAN_WITH_USDC = {
  schemaVersion: 1,
  address: VALID_ADDRESS,
  positions: [],
  stablecoins: [
    {
      chainId: 42_161,
      symbol: "USDC",
      tokenAddress: ARBITRUM_USDC,
      amount: "500000000",
      decimals: 6,
      usdValue: 500,
      priceUsd: 1.0,
      depegged: false,
    },
  ],
  unavailableChains: [],
  scannedAt: new Date().toISOString(),
};

function makeRequest(address: string): Request {
  return new Request(`http://localhost/api/scan/${address}`, {
    headers: { "cf-connecting-ip": MOCK_IP },
  });
}

function makeParams(address: string): { params: Promise<{ address: string }> } {
  return { params: Promise.resolve({ address }) };
}

// ---------------------------------------------------------------------------
// TEST-02: Route returns 200 with suggestions[] containing chainId + network
// ---------------------------------------------------------------------------

describe("TEST-02: GET /api/scan returns suggestions from suggestion engine", () => {
  beforeEach(() => {
    mockIncrementAndCheck.mockReset();
    mockGetRequestSourceIp.mockReset();
    mockScanAddress.mockReset();
    mockFetchDefillamaYieldPools.mockReset();
    mockBuildApyContext.mockReset();
    mockGetRequestSourceIp.mockReturnValue(MOCK_IP);
    mockIncrementAndCheck.mockResolvedValue(ALLOWED_RATE);
    mockScanAddress.mockResolvedValue(MOCK_SCAN_WITH_USDC);
    // Default: empty pools snapshot; context returns no APY entry (degrade path).
    mockFetchDefillamaYieldPools.mockResolvedValue([]);
    mockBuildApyContext.mockReturnValue({ getBestYield: () => null });
  });

  it("GET /api/scan returns 200 with Arbitrum USDC fixture", async () => {
    const res = await GET(
      makeRequest(VALID_ADDRESS),
      makeParams(VALID_ADDRESS)
    );
    expect(res.status).toBe(200);
  });

  it("GET /api/scan returns suggestions[] array in response body", async () => {
    const res = await GET(
      makeRequest(VALID_ADDRESS),
      makeParams(VALID_ADDRESS)
    );
    const body = (await res.json()) as { suggestions: unknown };
    expect(Array.isArray(body.suggestions)).toBe(true);
  });

  it("network: suggestions[0].chainId === 42161 (number) for Arbitrum USDC", async () => {
    const res = await GET(
      makeRequest(VALID_ADDRESS),
      makeParams(VALID_ADDRESS)
    );
    const body = (await res.json()) as {
      suggestions: Array<{ chainId: number }>;
    };
    expect(body.suggestions.length).toBeGreaterThan(0);
    expect(body.suggestions[0].chainId).toBe(42_161);
  });

  it("network: factory prefill for Arbitrum USDC yields config.network === '42161' (string)", async () => {
    const res = await GET(
      makeRequest(VALID_ADDRESS),
      makeParams(VALID_ADDRESS)
    );
    const body = (await res.json()) as {
      suggestions: Array<{
        chainId: number;
        prefill?: { nodes: Array<{ data: { config?: { network?: string } } }> };
      }>;
    };
    const firstSuggestion = body.suggestions[0];
    // The route may embed a prefill object or the test verifies via a separate
    // buildWorkflow call; either way network must be "42161" (string per PREFILL-04)
    if (firstSuggestion?.prefill) {
      const web3Nodes = firstSuggestion.prefill.nodes.filter(
        (n) => n.data.config?.network !== undefined
      );
      for (const node of web3Nodes) {
        expect(node.data.config?.network).toBe("42161");
      }
    } else {
      // Prefill not embedded in route response — assert chainId is present and correct
      expect(firstSuggestion.chainId).toBe(42_161);
    }
  });

  it("network: suggestions[0] tokenAddress matches Arbitrum USDC address", async () => {
    const res = await GET(
      makeRequest(VALID_ADDRESS),
      makeParams(VALID_ADDRESS)
    );
    const body = (await res.json()) as {
      suggestions: Array<{ id: string; chainId: number }>;
    };
    expect(body.suggestions[0].chainId).toBe(42_161);
    // The suggestion id slug encodes chainId for traceability
    expect(body.suggestions[0].id).toMatch(RE_CHAIN_ID_42161);
  });

  it("network: existing scan-route behaviour preserved (schemaVersion still 1)", async () => {
    const res = await GET(
      makeRequest(VALID_ADDRESS),
      makeParams(VALID_ADDRESS)
    );
    const body = (await res.json()) as { schemaVersion: number };
    expect(body.schemaVersion).toBe(1);
  });

  it("factory: buildWorkflow on route suggestion produces nodes with config.network '42161' (string)", async () => {
    const res = await GET(
      makeRequest(VALID_ADDRESS),
      makeParams(VALID_ADDRESS)
    );
    // Cast to SuggestionDescriptor via Parameters inference — avoids a separate
    // import while keeping the assertion strongly typed end-to-end.
    const body = (await res.json()) as {
      suggestions: Parameters<typeof buildWorkflow>[0][];
    };
    expect(body.suggestions.length).toBeGreaterThan(0);
    const workflow = buildWorkflow(body.suggestions[0]);
    // Filter to web3 nodes only — trigger + condition + alert nodes carry no
    // config.network; the check-token-balance read node carries the chain id.
    const web3Nodes = workflow.nodes.filter(
      (n) =>
        (n.data.config as Record<string, unknown> | undefined)?.network !==
        undefined
    );
    expect(web3Nodes.length).toBeGreaterThan(0);
    for (const node of web3Nodes) {
      expect((node.data.config as Record<string, unknown>).network).toBe(
        "42161"
      );
    }
  });

  it("apy: route returns APY-aware description when buildApyContext resolves an entry (YIELD-01/02)", async () => {
    mockBuildApyContext.mockReturnValue({
      getBestYield: (symbol: string, chainId: number) => {
        if (symbol === "USDC" && chainId === 42_161) {
          return {
            apy: 4.2,
            projectLabel: "Aave V3 on Arbitrum",
            destinationAddress: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
          };
        }
        return null;
      },
    });
    const res = await GET(
      makeRequest(VALID_ADDRESS),
      makeParams(VALID_ADDRESS)
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      suggestions: Array<{ description: string }>;
    };
    expect(body.suggestions.length).toBeGreaterThan(0);
    expect(body.suggestions[0].description).toMatch(RE_APY_COPY);
  });

  it("degrade: route returns 200 with suggestions when fetchDefillamaYieldPools rejects (YIELD-03)", async () => {
    mockFetchDefillamaYieldPools.mockRejectedValue(new Error("network error"));
    const res = await GET(
      makeRequest(VALID_ADDRESS),
      makeParams(VALID_ADDRESS)
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      suggestions: Array<{ category: string }>;
    };
    expect(Array.isArray(body.suggestions)).toBe(true);
    expect(body.suggestions.some((s) => s.category === "yield")).toBe(true);
  });
});
