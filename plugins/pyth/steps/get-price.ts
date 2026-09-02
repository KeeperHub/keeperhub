import "server-only";

import { fetchCredentials } from "@/lib/credential-fetcher";
import { safeFetch } from "@/lib/safe-fetch";
import { getErrorMessage } from "@/lib/utils";
import { runPluginStep, type StepInput } from "@/lib/workflow/executor/step-handler";
import type { PythCredentials } from "../credentials";
import {
  getPythBaseUrl,
  getPythHeaders,
  parsePythPrice,
  resolvePythFeedId,
} from "./pyth-core";

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

export type GetPythPriceInput = StepInput &
  GetPythPriceCoreInput & {
    integrationId?: string;
  };

async function stepHandler(
  input: GetPythPriceInput,
  credentials: PythCredentials
): Promise<GetPythPriceResult> {
  if (!input.feedId || input.feedId.trim() === "") {
    return {
      success: false,
      error: "Feed ID or symbol is required (e.g. ETH/USD, BTC/USD, or hex feed ID).",
    };
  }

  const apiKey = credentials.PYTH_API_KEY;
  const endpointUrl = credentials.PYTH_ENDPOINT_URL;

  try {
    const feedId = await resolvePythFeedId(input.feedId, apiKey, endpointUrl);
    const baseUrl = getPythBaseUrl(endpointUrl);
    const headers = getPythHeaders(apiKey);

    const url = `${baseUrl}/v2/updates/price/latest?ids[]=${encodeURIComponent(feedId)}`;

    const response = await safeFetch(url, {
      plugin: "pyth",
      method: "GET",
      headers,
    });

    if (!response.ok) {
      const statusMsg = response.statusText ? ` ${response.statusText}` : "";
      return {
        success: false,
        error: `Pyth API returned status ${response.status}${statusMsg}`,
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

    if (priceFloat === null || confFloat === null || emaPriceFloat === null || emaConfFloat === null) {
      return {
        success: false,
        error: `Pyth API returned non-numeric price data for feed ID ${feedId}`,
      };
    }

    const resolvedFeedId = json.parsed[0].id.startsWith("0x")
      ? json.parsed[0].id.toLowerCase()
      : `0x${json.parsed[0].id.toLowerCase()}`;

    return {
      success: true,
      price: priceFloat,
      priceString: priceFloat.toString(),
      confidence: confFloat,
      expo: priceObj.expo,
      publishTime: priceObj.publish_time,
      feedId: resolvedFeedId,
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

  const credentials = input.integrationId
    ? ((await fetchCredentials(input.integrationId, {
        organizationId: input._context?.organizationId ?? null,
      })) as PythCredentials)
    : {};

  return runPluginStep(
    { pluginName: "pyth", actionName: "get-price" },
    input,
    () => stepHandler(input, credentials)
  );
}

export const _integrationType = "pyth";
