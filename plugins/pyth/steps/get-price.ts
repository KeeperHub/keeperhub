import "server-only";

import { safeFetch } from "@/lib/safe-fetch";
import { getErrorMessage } from "@/lib/utils";
import { type StepInput, withStepLogging } from "@/lib/workflow/executor/step-handler";

const WELL_KNOWN_FEEDS: Record<string, string> = {
  ETH: "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
  "ETH/USD": "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
  BTC: "0xe62df6e22cc06fd0407e5e28cd33db5482645587149c9672d1e716d561230664",
  "BTC/USD": "0xe62df6e22cc06fd0407e5e28cd33db5482645587149c9672d1e716d561230664",
  SOL: "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  "SOL/USD": "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  USDC: "0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a",
  "USDC/USD": "0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a",
  USDT: "0x2b9583030550f63d07a6c6e28382f53ac801acb40026e6702e0719875f0a2027",
  "USDT/USD": "0x2b9583030550f63d07a6c6e28382f53ac801acb40026e6702e0719875f0a2027",
  LINK: "0x863f10115e45a2786a761e389a05b38ed6b1b51e5e6a3d905183424d5500e5a8",
  "LINK/USD": "0x863f10115e45a2786a761e389a05b38ed6b1b51e5e6a3d905183424d5500e5a8",
  ARB: "0x3fa425286be51304125f5d04446a15234559868772a45a303dd5351f0b001a18",
  "ARB/USD": "0x3fa425286be51304125f5d04446a15234559868772a45a303dd5351f0b001a18",
  OP: "0x385f64812b10a2e7c376182c18d7f76ca095eed882b3d88b4382bcce1bfd9e33",
  "OP/USD": "0x385f64812b10a2e7c376182c18d7f76ca095eed882b3d88b4382bcce1bfd9e33",
};

export type GetPythPriceResult =
  | {
      success: true;
      price: number;
      priceString: string;
      confidence: number;
      expo: number;
      publishTime: number;
      feedId: string;
      rawPrice: string;
      rawConf: string;
      emaPrice: number;
      emaConfidence: number;
    }
  | { success: false; error: string };

export type GetPythPriceCoreInput = {
  feedId: string;
};

export type GetPythPriceInput = StepInput & GetPythPriceCoreInput;

export function resolvePythFeedId(inputFeedId: string): string {
  const trimmed = inputFeedId.trim();
  const uppercaseKey = trimmed.toUpperCase();

  if (WELL_KNOWN_FEEDS[uppercaseKey]) {
    return WELL_KNOWN_FEEDS[uppercaseKey];
  }

  let formatted = trimmed;
  if (!formatted.startsWith("0x") && !formatted.startsWith("0X")) {
    formatted = `0x${formatted}`;
  }
  return formatted.toLowerCase();
}

export function parsePythPrice(rawPrice: string, expo: number): number {
  const num = Number.parseFloat(rawPrice);
  if (Number.isNaN(num)) return 0;
  return num * 10 ** expo;
}

async function stepHandler(
  input: GetPythPriceCoreInput
): Promise<GetPythPriceResult> {
  if (!input.feedId || input.feedId.trim() === "") {
    return {
      success: false,
      error: "Feed ID or symbol is required (e.g. ETH/USD, BTC/USD, or hex feed ID).",
    };
  }

  const feedId = resolvePythFeedId(input.feedId);

  try {
    const url = `https://hermes.pyth.network/v2/updates/price/latest?ids[]=${encodeURIComponent(feedId)}`;

    const response = await safeFetch(url, {
      plugin: "pyth",
      method: "GET",
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      return {
        success: false,
        error: `Pyth API returned status ${response.status}: ${response.statusText}`,
      };
    }

    const json = (await response.json()) as {
      parsed?: Array<{
        id: string;
        price: { price: string; conf: string; expo: number; publish_time: number };
        ema_price: { price: string; conf: string; expo: number; publish_time: number };
      }>;
    };

    if (!json.parsed || json.parsed.length === 0) {
      return {
        success: false,
        error: `No price data found for Pyth feed ID ${feedId}`,
      };
    }

    const priceObj = json.parsed[0].price;
    const emaObj = json.parsed[0].ema_price;

    const priceFloat = parsePythPrice(priceObj.price, priceObj.expo);
    const confFloat = parsePythPrice(priceObj.conf, priceObj.expo);

    const emaPriceFloat = parsePythPrice(emaObj.price, emaObj.expo);
    const emaConfFloat = parsePythPrice(emaObj.conf, emaObj.expo);

    return {
      success: true,
      price: priceFloat,
      priceString: priceFloat.toString(),
      confidence: confFloat,
      expo: priceObj.expo,
      publishTime: priceObj.publish_time,
      feedId: json.parsed[0].id.startsWith("0x") ? json.parsed[0].id : `0x${json.parsed[0].id}`,
      rawPrice: priceObj.price,
      rawConf: priceObj.conf,
      emaPrice: emaPriceFloat,
      emaConfidence: emaConfFloat,
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to fetch Pyth price: ${getErrorMessage(error)}`,
    };
  }
}

export async function getPriceStep(
  input: GetPythPriceInput
): Promise<GetPythPriceResult> {
  "use step";

  return withStepLogging(input, () => stepHandler(input));
}

export const _integrationType = "pyth";
