import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { safeFetch } = vi.hoisted(() => ({ safeFetch: vi.fn() }));
vi.mock("@/lib/safe-fetch", () => ({
  safeFetch,
}));

import pythPlugin from "@/plugins/pyth";
import {
  getPriceStep,
  parsePythPrice,
  resolvePythFeedId,
} from "@/plugins/pyth/steps/get-price";
import { getUpdateDataStep } from "@/plugins/pyth/steps/get-update-data";
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

describe("Pyth Network Plugin Definition", () => {
  it("has correct plugin metadata", () => {
    expect(pythPlugin.type).toBe("pyth");
    expect(pythPlugin.label).toBe("Pyth Network");
    expect(pythPlugin.requiresCredentials).toBe(false);
    expect(pythPlugin.egress).toBe("fixed-host");
    expect(pythPlugin.actions.length).toBe(3);
  });

  it("registers expected action slugs", () => {
    const slugs = pythPlugin.actions.map((a) => a.slug);
    expect(slugs).toContain("get-price");
    expect(slugs).toContain("get-update-data");
    expect(slugs).toContain("search-price-feeds");
  });
});

describe("Pyth Feed ID Resolution & Math", () => {
  it("resolves well-known symbols to feed IDs", () => {
    expect(resolvePythFeedId("ETH")).toBe(
      "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace"
    );
    expect(resolvePythFeedId("ETH/USD")).toBe(
      "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace"
    );
    expect(resolvePythFeedId("BTC/USD")).toBe(
      "0xe62df6e22cc06fd0407e5e28cd33db5482645587149c9672d1e716d561230664"
    );
    expect(resolvePythFeedId("SOL/USD")).toBe(
      "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d"
    );
  });

  it("formats 0x prefix on custom feed hex IDs", () => {
    const rawHex =
      "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace";
    expect(resolvePythFeedId(rawHex)).toBe(`0x${rawHex}`);

    const prefixedHex =
      "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace";
    expect(resolvePythFeedId(prefixedHex)).toBe(prefixedHex);
  });

  it("correctly converts raw integer string and negative exponent to price float", () => {
    // 345000000000 * 10^-8 = 3450
    expect(parsePythPrice("345000000000", -8)).toBe(3450);

    // 123456789 * 10^-5 = 1234.56789
    expect(parsePythPrice("123456789", -5)).toBeCloseTo(1234.567_89, 5);
  });
});

describe("Pyth Step Functions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("getPriceStep fetches and formats price correctly", async () => {
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

    const result = await getPriceStep({ feedId: "ETH/USD" });

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
  });

  it("getUpdateDataStep fetches VAA binary payload", async () => {
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

  it("searchPriceFeedsStep returns matching metadata", async () => {
    mockFetchOnce([
      {
        id: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
        attributes: {
          symbol: "Crypto.ETH/USD",
          asset_type: "crypto",
          base: "ETH",
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
      expect(result.count).toBe(1);
      expect(result.feeds[0].symbol).toBe("Crypto.ETH/USD");
      expect(result.feeds[0].id).toBe(
        "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace"
      );
    }
    expect(lastFetchUrl()).toContain("query=ETH");
  });
});
