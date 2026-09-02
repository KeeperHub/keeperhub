import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/workflow/executor/step-handler", () => ({
  runPluginStep: (
    _options: unknown,
    input: unknown,
    fn: (input: unknown) => unknown
  ) => fn(input),
  withStepLogging: (_input: unknown, fn: () => unknown) => fn(),
}));

const mockFetchCredentials = vi.fn();
vi.mock("@/lib/credential-fetcher", () => ({
  fetchCredentials: (...args: unknown[]) => mockFetchCredentials(...args),
}));

const { safeFetch } = vi.hoisted(() => ({ safeFetch: vi.fn() }));
vi.mock("@/lib/safe-fetch", () => ({
  safeFetch,
}));

import pythPlugin from "@/plugins/pyth";
import { getPriceStep } from "@/plugins/pyth/steps/get-price";
import { getUpdateDataStep } from "@/plugins/pyth/steps/get-update-data";
import {
  deriveBaseAndQuote,
  parsePythPrice,
  resolvePythFeedId,
  WELL_KNOWN_FEEDS,
} from "@/plugins/pyth/steps/pyth-core";
import { searchPriceFeedsStep } from "@/plugins/pyth/steps/search-price-feeds";

function mockFetchOnce(
  body: unknown,
  init?: { ok?: boolean; status?: number; statusText?: string }
) {
  const ok = init?.ok ?? true;
  const status = init?.status ?? 200;
  const statusText = init?.statusText ?? (ok ? "OK" : "Error");
  safeFetch.mockReset();
  safeFetch.mockResolvedValue({
    ok,
    status,
    statusText,
    json: () => Promise.resolve(body),
  });
}

function lastFetchUrl(): string {
  const calls = safeFetch.mock.calls;
  return String(calls.at(-1)?.[0]);
}

function lastFetchHeaders(): Record<string, string> {
  const calls = safeFetch.mock.calls;
  const opts = calls.at(-1)?.[1] as { headers?: Record<string, string> };
  return opts?.headers ?? {};
}

describe("Pyth Network Plugin Definition", () => {
  it("has correct plugin metadata", () => {
    expect(pythPlugin.type).toBe("pyth");
    expect(pythPlugin.label).toBe("Pyth Network");
    expect(pythPlugin.requiresCredentials).toBe(true);
    expect(pythPlugin.egress).toBe("fixed-host");
    expect(pythPlugin.actions.length).toBe(3);
    expect(pythPlugin.formFields.length).toBe(2);
  });

  it("registers expected action slugs", () => {
    const slugs = pythPlugin.actions.map((a) => a.slug);
    expect(slugs).toContain("get-price");
    expect(slugs).toContain("get-update-data");
    expect(slugs).toContain("search-price-feeds");
  });
});

describe("Pyth Feed ID Resolution & Math Helpers", () => {
  it("resolves accurate well-known symbols to feed IDs from catalogue", async () => {
    expect(await resolvePythFeedId("ETH")).toBe(WELL_KNOWN_FEEDS.ETH);
    expect(await resolvePythFeedId("ETH/USD")).toBe(
      WELL_KNOWN_FEEDS["ETH/USD"]
    );
    expect(await resolvePythFeedId("BTC/USD")).toBe(
      WELL_KNOWN_FEEDS["BTC/USD"]
    );
    expect(await resolvePythFeedId("SOL/USD")).toBe(
      WELL_KNOWN_FEEDS["SOL/USD"]
    );
    expect(await resolvePythFeedId("USDT/USD")).toBe(
      WELL_KNOWN_FEEDS["USDT/USD"]
    );
    expect(await resolvePythFeedId("LINK/USD")).toBe(
      WELL_KNOWN_FEEDS["LINK/USD"]
    );
    expect(await resolvePythFeedId("ARB/USD")).toBe(
      WELL_KNOWN_FEEDS["ARB/USD"]
    );
    expect(await resolvePythFeedId("OP/USD")).toBe(WELL_KNOWN_FEEDS["OP/USD"]);
  });

  it("formats 0x prefix on custom feed hex IDs", async () => {
    const rawHex =
      "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";
    expect(await resolvePythFeedId(rawHex)).toBe(`0x${rawHex}`);
  });

  it("correctly converts raw integer string and negative exponent to price float", () => {
    expect(parsePythPrice("345000000000", -8)).toBe(3450);
    expect(parsePythPrice("123456789", -5)).toBeCloseTo(1234.567_89, 5);
    expect(parsePythPrice("invalid", -8)).toBeNull();
  });

  it("derives base and quote from symbol correctly", () => {
    expect(deriveBaseAndQuote("Crypto.ETH/USD")).toEqual({
      base: "ETH",
      quote: "USD",
    });
    expect(deriveBaseAndQuote("BTC/USD")).toEqual({
      base: "BTC",
      quote: "USD",
    });
    expect(deriveBaseAndQuote("SOL")).toEqual({ base: "SOL", quote: "USD" });
  });
});

describe("Pyth Step Functions", () => {
  beforeEach(() => {
    mockFetchCredentials.mockReset();
    mockFetchCredentials.mockResolvedValue({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("getPriceStep fetches and formats price correctly with Authorization header", async () => {
    mockFetchCredentials.mockResolvedValue({
      PYTH_API_KEY: "test_secret_key",
    });

    mockFetchOnce({
      parsed: [
        {
          id: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
          price: {
            price: "345000000000",
            conf: "125000000",
            expo: -8,
            publish_time: 1_725_100_000,
          },
          ema_price: {
            price: "344500000000",
            conf: "110000000",
            expo: -8,
            publish_time: 1_725_100_000,
          },
        },
      ],
    });

    const result = await getPriceStep({
      feedId: "ETH/USD",
      integrationId: "int-1",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.price).toBe(3450);
      expect(result.priceString).toBe("3450");
      expect(result.confidence).toBe(1.25);
      expect(result.expo).toBe(-8);
      expect(result.publishTime).toBe(1_725_100_000);
      expect(result.feedId).toBe(
        "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace"
      );
    }
    expect(lastFetchUrl()).toContain(
      "https://hermes.pyth.network/v2/updates/price/latest"
    );
    expect(lastFetchHeaders().Authorization).toBe("Bearer test_secret_key");
  });

  it("getPriceStep fails cleanly on non-numeric price without fabricating zero", async () => {
    mockFetchOnce({
      parsed: [
        {
          id: "0xabc",
          price: { price: "invalid", conf: "100", expo: -8, publish_time: 123 },
          ema_price: { price: "100", conf: "100", expo: -8, publish_time: 123 },
        },
      ],
    });

    const result = await getPriceStep({ feedId: "ETH/USD" });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("non-numeric price data");
    }
  });

  it("getUpdateDataStep fetches VAA binary payload and respects response encoding", async () => {
    mockFetchOnce({
      binary: {
        encoding: "hex",
        data: ["00003b4a5c6d7e"],
      },
    });

    const result = await getUpdateDataStep({
      feedIds: "ETH/USD",
      encoding: "hex",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.updateData).toEqual(["0x00003b4a5c6d7e"]);
      expect(result.encoding).toBe("hex");
      expect(result.updateDataCount).toBe(1);
    }
  });

  it("searchPriceFeedsStep returns matching metadata and separate counts", async () => {
    mockFetchOnce([
      {
        id: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
        attributes: {
          symbol: "Crypto.ETH/USD",
          asset_type: "crypto",
          quote_currency: "USD",
        },
      },
    ]);

    const result = await searchPriceFeedsStep({
      query: "ETH",
      assetType: "crypto",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.matchingCount).toBe(1);
      expect(result.returnedCount).toBe(1);
      expect(result.feeds[0].symbol).toBe("Crypto.ETH/USD");
      expect(result.feeds[0].base).toBe("ETH");
      expect(result.feeds[0].quote).toBe("USD");
      expect(result.feeds[0].id).toBe(
        "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace"
      );
    }
    expect(lastFetchUrl()).toContain("query=ETH");
  });
});
