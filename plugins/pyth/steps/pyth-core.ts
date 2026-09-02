import { safeFetch } from "@/lib/safe-fetch";
import { getErrorMessage } from "@/lib/utils";

export const DEFAULT_PYTH_ENDPOINT = "https://hermes.pyth.network";

export const WELL_KNOWN_FEEDS: Record<string, string> = {
  ETH: "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
  "ETH/USD": "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
  BTC: "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  "BTC/USD": "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  SOL: "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  "SOL/USD": "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  USDC: "0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a",
  "USDC/USD": "0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a",
  USDT: "0x2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b",
  "USDT/USD": "0x2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b",
  LINK: "0x8ac0c70fff57e9aefdf5edf44b51d62c2d433653cbb2cf5cc06bb115af04d221",
  "LINK/USD": "0x8ac0c70fff57e9aefdf5edf44b51d62c2d433653cbb2cf5cc06bb115af04d221",
  ARB: "0x3fa4252848f9f0a1480be62745a4629d9eb1322aebab8a791e344b3b9c1adcf5",
  "ARB/USD": "0x3fa4252848f9f0a1480be62745a4629d9eb1322aebab8a791e344b3b9c1adcf5",
  OP: "0x385f64d993f7b77d8182ed5003d97c60aa3361f3cecfe711544d2d59165e9bdf",
  "OP/USD": "0x385f64d993f7b77d8182ed5003d97c60aa3361f3cecfe711544d2d59165e9bdf",
};

export function getPythBaseUrl(customUrl?: string): string {
  if (!customUrl || customUrl.trim() === "") {
    return DEFAULT_PYTH_ENDPOINT;
  }
  let trimmed = customUrl.trim();
  if (trimmed.endsWith("/")) {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed;
}

export function getPythHeaders(apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (apiKey && apiKey.trim() !== "") {
    const token = apiKey.trim().startsWith("Bearer ")
      ? apiKey.trim()
      : `Bearer ${apiKey.trim()}`;
    headers.Authorization = token;
  }
  return headers;
}

export function parsePythPrice(rawPrice: string, expo: number): number | null {
  const num = Number.parseFloat(rawPrice);
  if (Number.isNaN(num) || !Number.isFinite(num)) {
    return null;
  }
  return num * 10 ** expo;
}

export function deriveBaseAndQuote(symbol?: string): { base: string; quote: string } {
  if (!symbol || symbol.trim() === "") {
    return { base: "", quote: "USD" };
  }

  let clean = symbol.trim();
  if (clean.includes(".")) {
    const parts = clean.split(".");
    clean = parts[parts.length - 1] ?? clean;
  }

  if (clean.includes("/")) {
    const pair = clean.split("/");
    return { base: pair[0] ?? "", quote: pair[1] ?? "USD" };
  }

  return { base: clean, quote: "USD" };
}

export async function resolvePythFeedId(
  inputFeedId: string,
  apiKey?: string,
  endpointUrl?: string
): Promise<string> {
  const trimmed = inputFeedId.trim();
  const uppercaseKey = trimmed.toUpperCase();

  if (WELL_KNOWN_FEEDS[uppercaseKey]) {
    return WELL_KNOWN_FEEDS[uppercaseKey];
  }

  const hexPattern = /^(0x)?[0-9a-fA-F]{64}$/;
  if (hexPattern.test(trimmed)) {
    return trimmed.startsWith("0x") || trimmed.startsWith("0X")
      ? trimmed.toLowerCase()
      : `0x${trimmed.toLowerCase()}`;
  }

  try {
    const baseUrl = getPythBaseUrl(endpointUrl);
    const searchUrl = `${baseUrl}/v2/price_feeds?query=${encodeURIComponent(trimmed)}`;
    const res = await safeFetch(searchUrl, {
      plugin: "pyth",
      method: "GET",
      headers: getPythHeaders(apiKey),
    });

    if (res.ok) {
      const feeds = (await res.json()) as Array<{ id: string; attributes?: { symbol?: string } }>;
      if (Array.isArray(feeds) && feeds.length > 0) {
        const match = feeds.find(
          (f) =>
            f.attributes?.symbol?.toUpperCase() === uppercaseKey ||
            f.attributes?.symbol?.toUpperCase() === `CRYPTO.${uppercaseKey}`
        ) ?? feeds[0];

        const resolvedId = match.id;
        return resolvedId.startsWith("0x") ? resolvedId.toLowerCase() : `0x${resolvedId.toLowerCase()}`;
      }
    }
  } catch (_err) {
    // Fall back to formatted raw input if dynamic resolution fails
  }

  return trimmed.startsWith("0x") ? trimmed.toLowerCase() : `0x${trimmed.toLowerCase()}`;
}
