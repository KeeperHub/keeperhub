import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/workflow/executor/step-handler", async () =>
  (await import("../mocks/step-mocks")).stepHandlerPassthrough()
);

vi.mock("@/lib/metrics/instrumentation/plugin", async () =>
  (await import("../mocks/step-mocks")).pluginMetricsPassthrough()
);

const mockFetchCredentials = vi.fn();
vi.mock("@/lib/credential-fetcher", () => ({
  fetchCredentials: (...args: unknown[]) => mockFetchCredentials(...args),
}));

// Blockscout egress routes through safeFetch (the SSRF guard), not the raw
// fetch global. Mock it so these tests assert on the URL passed to safeFetch.
const { safeFetch } = vi.hoisted(() => ({ safeFetch: vi.fn() }));
// blockscout-core runs an always-on assertUrlIsPublic SSRF pre-check before
// safeFetch; stub it to resolve so these tests exercise the fetch path against
// the (public) hosted instances. SsrfBlockedError must be a real class so the
// `instanceof` branch in blockscout-core's catch is callable.
vi.mock("@/lib/safe-fetch", () => ({
  safeFetch,
  assertUrlIsPublic: vi.fn(() => Promise.resolve()),
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}));

import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import { getAddressBalanceStep } from "@/plugins/blockscout/steps/get-address-balance";
import { getAddressCountersStep } from "@/plugins/blockscout/steps/get-address-counters";
import { getAddressInfoStep } from "@/plugins/blockscout/steps/get-address-info";
import { getTokenInfoStep } from "@/plugins/blockscout/steps/get-token-info";
import { getTransactionStep } from "@/plugins/blockscout/steps/get-transaction";

function mockFetchOnce(
  body: unknown,
  init?: { ok?: boolean; status?: number }
) {
  const ok = init?.ok ?? true;
  const status = init?.status ?? 200;
  safeFetch.mockReset();
  safeFetch.mockResolvedValue({
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    json: () => Promise.resolve(body),
  });
}

function lastFetchUrl(): string {
  const calls = safeFetch.mock.calls;
  return String(calls.at(-1)?.[0]);
}

describe("blockscout get-address-balance", () => {
  beforeEach(() => {
    mockFetchCredentials.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns balance and metadata from the default instance", async () => {
    mockFetchOnce({
      hash: "0xabc",
      coin_balance: "12345",
      is_contract: false,
      ens_domain_name: "vitalik.eth",
    });

    const result = await getAddressBalanceStep({ address: "0xabc" });

    expect(result).toEqual({
      success: true,
      address: "0xabc",
      balance: "12345",
      isContract: false,
      ensName: "vitalik.eth",
    });
    expect(lastFetchUrl()).toContain(
      "https://eth.blockscout.com/api/v2/addresses/0xabc"
    );
  });

  it("uses the configured instance URL and appends the API key", async () => {
    mockFetchCredentials.mockResolvedValue({
      BLOCKSCOUT_API_URL: "https://base.blockscout.com/",
      BLOCKSCOUT_API_KEY: "secret",
    });
    mockFetchOnce({ hash: "0xabc", coin_balance: "0" });

    await getAddressBalanceStep({ address: "0xabc", integrationId: "int-1" });

    const url = lastFetchUrl();
    expect(url).toContain("https://base.blockscout.com/api/v2/addresses/0xabc");
    expect(url).toContain("apikey=secret");
  });

  it("rejects an empty address without calling fetch", async () => {
    global.fetch = vi.fn() as unknown as typeof fetch;
    const result = await getAddressBalanceStep({ address: "  " });

    expect(result).toEqual({
      success: false,
      error: "Address is required.",
      errorClass: ExecutionErrorType.USER,
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("maps a 404 to a not-found error", async () => {
    mockFetchOnce({}, { ok: false, status: 404 });
    const result = await getAddressBalanceStep({ address: "0xabc" });

    expect(result).toEqual({
      success: false,
      error: "Not found on this Blockscout instance.",
      errorClass: ExecutionErrorType.USER,
    });
  });
});

describe("blockscout get-transaction", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("flattens transaction details", async () => {
    mockFetchOnce({
      hash: "0xtx",
      status: "ok",
      value: "1000",
      from: { hash: "0xfrom" },
      to: { hash: "0xto" },
      block_number: 42,
      fee: { value: "21" },
      method: "transfer",
    });

    const result = await getTransactionStep({ txHash: "0xtx" });

    expect(result).toEqual({
      success: true,
      hash: "0xtx",
      status: "ok",
      value: "1000",
      from: "0xfrom",
      to: "0xto",
      blockNumber: 42,
      fee: "21",
      method: "transfer",
    });
  });

  it("rejects an empty transaction hash", async () => {
    global.fetch = vi.fn() as unknown as typeof fetch;
    const result = await getTransactionStep({ txHash: "" });

    expect(result).toEqual({
      success: false,
      error: "Transaction hash is required.",
      errorClass: ExecutionErrorType.USER,
    });
  });
});

describe("blockscout get-token-info", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns token metadata", async () => {
    mockFetchOnce({
      address_hash: "0xTOKENchecksum",
      name: "Tether USD",
      symbol: "USDT",
      decimals: "6",
      total_supply: "9000",
      type: "ERC-20",
      holders_count: "100",
    });

    const result = await getTokenInfoStep({ tokenAddress: "0xtoken" });

    expect(result).toEqual({
      success: true,
      address: "0xTOKENchecksum",
      name: "Tether USD",
      symbol: "USDT",
      decimals: "6",
      totalSupply: "9000",
      type: "ERC-20",
      holders: "100",
    });
  });

  it("rejects an empty token address", async () => {
    global.fetch = vi.fn() as unknown as typeof fetch;
    const result = await getTokenInfoStep({ tokenAddress: "" });

    expect(result).toEqual({
      success: false,
      error: "Token address is required.",
      errorClass: ExecutionErrorType.USER,
    });
  });
});

describe("blockscout get-address-info", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("flattens the full address summary with defaults", async () => {
    mockFetchOnce({
      hash: "0xabc",
      coin_balance: "3121840566764650005",
      exchange_rate: "2127.52",
      is_scam: false,
      is_verified: true,
      is_contract: true,
      reputation: "ok",
      ens_domain_name: "vitalik.eth",
      proxy_type: "eip7702",
      public_tags: [],
      has_token_transfers: true,
      has_tokens: true,
      has_logs: false,
      block_number_balance_updated_at: 45_911_658,
    });

    const result = await getAddressInfoStep({ address: "0xabc" });

    expect(result).toEqual({
      success: true,
      address: "0xabc",
      coinBalance: "3121840566764650005",
      exchangeRate: "2127.52",
      isScam: false,
      isVerified: true,
      isContract: true,
      reputation: "ok",
      ensName: "vitalik.eth",
      proxyType: "eip7702",
      publicTags: [],
      hasTokenTransfers: true,
      hasTokens: true,
      hasLogs: false,
      blockNumberBalanceUpdatedAt: 45_911_658,
    });
  });

  it("applies safe defaults for missing fields", async () => {
    // Empty body: exercises every fallback, including address <- input.address
    mockFetchOnce({});

    const result = await getAddressInfoStep({ address: "0xabc" });

    expect(result).toEqual({
      success: true,
      address: "0xabc",
      coinBalance: "0",
      exchangeRate: null,
      isScam: false,
      isVerified: false,
      isContract: false,
      reputation: null,
      ensName: null,
      proxyType: null,
      publicTags: [],
      hasTokenTransfers: false,
      hasTokens: false,
      hasLogs: false,
      blockNumberBalanceUpdatedAt: null,
    });
  });

  it("rejects an empty address", async () => {
    global.fetch = vi.fn() as unknown as typeof fetch;
    const result = await getAddressInfoStep({ address: "" });

    expect(result).toEqual({
      success: false,
      error: "Address is required.",
      errorClass: ExecutionErrorType.USER,
    });
  });
});

describe("blockscout get-address-counters", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns activity counters", async () => {
    mockFetchOnce({
      transactions_count: "36251",
      token_transfers_count: "86562",
      gas_usage_count: "10772437",
      validations_count: "0",
    });

    const result = await getAddressCountersStep({ address: "0xabc" });

    expect(result).toEqual({
      success: true,
      transactionsCount: "36251",
      tokenTransfersCount: "86562",
      gasUsageCount: "10772437",
      validationsCount: "0",
    });
    expect(lastFetchUrl()).toContain("/api/v2/addresses/0xabc/counters");
  });

  it("defaults missing counters to zero", async () => {
    mockFetchOnce({});

    const result = await getAddressCountersStep({ address: "0xabc" });

    expect(result).toEqual({
      success: true,
      transactionsCount: "0",
      tokenTransfersCount: "0",
      gasUsageCount: "0",
      validationsCount: "0",
    });
  });

  it("rejects an empty address", async () => {
    global.fetch = vi.fn() as unknown as typeof fetch;
    const result = await getAddressCountersStep({ address: "  " });

    expect(result).toEqual({
      success: false,
      error: "Address is required.",
      errorClass: ExecutionErrorType.USER,
    });
  });
});

describe("blockscout chain selection", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("queries the selected chain's hosted instance (Base)", async () => {
    mockFetchOnce({ hash: "0xabc" });

    await getAddressInfoStep({ address: "0xabc", network: "8453" });

    expect(lastFetchUrl()).toContain(
      "https://base.blockscout.com/api/v2/addresses/0xabc"
    );
  });

  it("maps Optimism to its canonical instance", async () => {
    mockFetchOnce({});

    await getAddressCountersStep({ address: "0xabc", network: "10" });

    expect(lastFetchUrl()).toContain(
      "https://explorer.optimism.io/api/v2/addresses/0xabc/counters"
    );
  });

  it("defaults to Ethereum mainnet when no chain is selected", async () => {
    mockFetchOnce({ hash: "0xabc" });

    await getAddressInfoStep({ address: "0xabc" });

    expect(lastFetchUrl()).toContain("https://eth.blockscout.com/");
  });

  it("errors for a chain with no hosted instance and no connection", async () => {
    global.fetch = vi.fn() as unknown as typeof fetch;

    const result = await getAddressInfoStep({
      address: "0xabc",
      network: "999999",
    });

    expect(result.success).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
    if (result.success === false) {
      expect(result.error).toContain("No hosted Blockscout instance");
    }
  });

  it("lets a connection instance URL override the selected chain", async () => {
    mockFetchCredentials.mockResolvedValue({
      BLOCKSCOUT_API_URL: "https://custom.blockscout.example",
    });
    mockFetchOnce({ hash: "0xabc" });

    await getAddressInfoStep({
      address: "0xabc",
      network: "8453",
      integrationId: "int-1",
    });

    expect(lastFetchUrl()).toContain(
      "https://custom.blockscout.example/api/v2/addresses/0xabc"
    );
  });
});
