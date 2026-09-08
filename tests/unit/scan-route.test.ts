/**
 * Unit tests for GET /api/scan/[address] — the public, unauthenticated
 * scan route.
 *
 * Verifies: address validation (400 on malformed), rate-limit enforcement
 * (429 when the backoff limiter denies, scanAddress NOT called), happy path
 * (200 + scanAddress called once with the rate-limit key `scan:<ip>`), and
 * HARDEN-01 abuse telemetry on 429.
 *
 * Mocks: incrementAndCheckWithBackoff, getRequestSourceIp, scanAddress,
 *        logAnonymousExecutionBlock.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const {
  mockIncrementAndCheck,
  mockGetRequestSourceIp,
  mockScanAddress,
  mockLogAnonymousExecutionBlock,
  mockResolveEnsName,
} = vi.hoisted(() => ({
  mockIncrementAndCheck: vi.fn(),
  mockGetRequestSourceIp: vi.fn(),
  mockScanAddress: vi.fn(),
  mockLogAnonymousExecutionBlock: vi.fn(),
  mockResolveEnsName: vi.fn(),
}));

// Keep the real ENS_NAME_REGEX (used for the shape check) and override only
// the resolver so tests control resolution without hitting an RPC.
vi.mock("@/lib/scan/resolve-ens", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/scan/resolve-ens")>()),
  resolveEnsName: mockResolveEnsName,
}));

vi.mock("@/lib/scan/rate-limit", () => ({
  incrementAndCheckWithBackoff: mockIncrementAndCheck,
}));

vi.mock("@/lib/security/request-attribution", () => ({
  getRequestSourceIp: mockGetRequestSourceIp,
}));

vi.mock("@/lib/scan/scanner", () => ({
  scanAddress: mockScanAddress,
}));

vi.mock("@/lib/auth-anonymous-guard", () => ({
  logAnonymousExecutionBlock: mockLogAnonymousExecutionBlock,
}));

const { GET } = await import("@/app/api/scan/[address]/route");

const VALID_ADDRESS = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const MOCK_IP = "1.2.3.4";

const ALLOWED_RATE = {
  allowed: true as const,
  count: 1,
  limit: 6,
  remaining: 5,
  reset: 9_999_999_999,
};

const DENIED_RATE = {
  allowed: false as const,
  retryAfter: 1200,
  count: 7,
  limit: 6,
  remaining: 0,
  reset: 9_999_999_999,
};

function makeRequest(address: string): Request {
  return new Request(`http://localhost/api/scan/${address}`, {
    headers: { "cf-connecting-ip": MOCK_IP },
  });
}

function makeParams(address: string): { params: Promise<{ address: string }> } {
  return { params: Promise.resolve({ address }) };
}

describe("GET /api/scan/[address]", () => {
  beforeEach(() => {
    mockIncrementAndCheck.mockReset();
    mockGetRequestSourceIp.mockReset();
    mockScanAddress.mockReset();
    mockLogAnonymousExecutionBlock.mockReset();
    mockResolveEnsName.mockReset();
    mockGetRequestSourceIp.mockReturnValue(MOCK_IP);
    mockIncrementAndCheck.mockResolvedValue(ALLOWED_RATE);
    mockScanAddress.mockResolvedValue({
      schemaVersion: 1,
      address: VALID_ADDRESS,
      positions: [],
      stablecoins: [],
      unavailableChains: [],
      scannedAt: new Date().toISOString(),
    });
  });

  it("invalid address: returns 400 without touching rate limit or scanner", async () => {
    const res = await GET(
      makeRequest("notanaddress"),
      makeParams("notanaddress")
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Invalid address");
    expect(mockIncrementAndCheck).not.toHaveBeenCalled();
    expect(mockScanAddress).not.toHaveBeenCalled();
    expect(mockResolveEnsName).not.toHaveBeenCalled();
  });

  it("ENS name: resolves to an address, scans it, and echoes ensName", async () => {
    mockResolveEnsName.mockResolvedValue(VALID_ADDRESS);
    const res = await GET(
      makeRequest("vitalik.eth"),
      makeParams("vitalik.eth")
    );
    expect(res.status).toBe(200);
    expect(mockResolveEnsName).toHaveBeenCalledWith("vitalik.eth");
    expect(mockScanAddress).toHaveBeenCalledWith(VALID_ADDRESS);
    const body = (await res.json()) as { ensName?: string };
    expect(body.ensName).toBe("vitalik.eth");
  });

  it("unresolvable ENS name: 400 after rate limit, scanner not called", async () => {
    mockResolveEnsName.mockResolvedValue(null);
    const res = await GET(makeRequest("nope.eth"), makeParams("nope.eth"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Could not resolve ENS name");
    // ENS resolution is RPC work, so it must sit behind the rate limit.
    expect(mockIncrementAndCheck).toHaveBeenCalledTimes(1);
    expect(mockScanAddress).not.toHaveBeenCalled();
  });

  it("rate limit: returns 429 without calling scanAddress when the backoff limiter denies", async () => {
    mockIncrementAndCheck.mockResolvedValue(DENIED_RATE);
    const res = await GET(
      makeRequest(VALID_ADDRESS),
      makeParams(VALID_ADDRESS)
    );
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string; retryAfter: number };
    expect(body.error).toBe("Rate limit exceeded");
    expect(body.retryAfter).toBe(1200);
    expect(mockScanAddress).not.toHaveBeenCalled();
  });

  it("happy path: returns 200 with scan result; scanAddress called once with rate-limit key scan:<ip>", async () => {
    const res = await GET(
      makeRequest(VALID_ADDRESS),
      makeParams(VALID_ADDRESS)
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { schemaVersion: number };
    expect(body.schemaVersion).toBe(1);
    expect(mockScanAddress).toHaveBeenCalledTimes(1);
    expect(mockScanAddress).toHaveBeenCalledWith(VALID_ADDRESS);
    expect(mockIncrementAndCheck).toHaveBeenCalledWith(
      `scan:${MOCK_IP}`,
      30,
      30
    );
  });

  // HARDEN-01: abuse telemetry on 429
  it("emits abuse telemetry before returning 429", async () => {
    mockIncrementAndCheck.mockResolvedValue(DENIED_RATE);
    const res = await GET(
      makeRequest(VALID_ADDRESS),
      makeParams(VALID_ADDRESS)
    );
    expect(res.status).toBe(429);
    // RED: logAnonymousExecutionBlock is not yet called in the route (55-02 adds it)
    expect(mockLogAnonymousExecutionBlock).toHaveBeenCalledWith("scan", null, {
      ip: MOCK_IP,
      rateLimitCount: "7",
      address: VALID_ADDRESS,
    });
  });
});
