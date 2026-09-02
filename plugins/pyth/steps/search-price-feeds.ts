import "server-only";

import { fetchCredentials } from "@/lib/credential-fetcher";
import { safeFetch } from "@/lib/safe-fetch";
import { getErrorMessage } from "@/lib/utils";
import { runPluginStep, type StepInput } from "@/lib/workflow/executor/step-handler";
import type { PythCredentials } from "../credentials";
import {
  deriveBaseAndQuote,
  getPythBaseUrl,
  getPythHeaders,
} from "./pyth-core";

export type PythFeedMetaData = {
  id: string;
  symbol: string;
  assetType: string;
  base: string;
  quote: string;
};

export type SearchPythPriceFeedsResult =
  | {
      success: true;
      feeds: PythFeedMetaData[];
      matchingCount: number;
      returnedCount: number;
    }
  | { success: false; error: string };

export type SearchPythPriceFeedsCoreInput = {
  query?: string;
  assetType?: string;
};

export type SearchPythPriceFeedsInput = StepInput &
  SearchPythPriceFeedsCoreInput & {
    integrationId?: string;
  };

async function stepHandler(
  input: SearchPythPriceFeedsInput,
  credentials: PythCredentials
): Promise<SearchPythPriceFeedsResult> {
  const apiKey = credentials.PYTH_API_KEY;
  const endpointUrl = credentials.PYTH_ENDPOINT_URL;

  try {
    const baseUrl = getPythBaseUrl(endpointUrl);
    const headers = getPythHeaders(apiKey);

    const queryParams = new URLSearchParams();
    if (input.query && input.query.trim() !== "") {
      queryParams.append("query", input.query.trim());
    }
    if (input.assetType && input.assetType.trim() !== "") {
      queryParams.append("asset_type", input.assetType.trim());
    }

    const url = `${baseUrl}/v2/price_feeds?${queryParams.toString()}`;

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

    const json = (await response.json()) as Array<{
      id: string;
      attributes?: {
        symbol?: string;
        asset_type?: string;
        quote_currency?: string;
      };
    }>;

    if (!Array.isArray(json)) {
      return {
        success: false,
        error: "Invalid price feeds format returned from Pyth API.",
      };
    }

    const matchingCount = json.length;
    const sliced = json.slice(0, 50);

    const feeds: PythFeedMetaData[] = sliced.map((item) => {
      const feedId = item.id.startsWith("0x")
        ? item.id.toLowerCase()
        : `0x${item.id.toLowerCase()}`;

      const rawSymbol = item.attributes?.symbol ?? "Unknown";
      const { base, quote } = deriveBaseAndQuote(rawSymbol);

      return {
        id: feedId,
        symbol: rawSymbol,
        assetType: item.attributes?.asset_type ?? "crypto",
        base,
        quote: item.attributes?.quote_currency ?? quote,
      };
    });

    return {
      success: true,
      feeds,
      matchingCount,
      returnedCount: feeds.length,
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to search Pyth price feeds: ${getErrorMessage(error)}`,
    };
  }
}

export async function searchPriceFeedsStep(
  input: SearchPythPriceFeedsInput
): Promise<SearchPythPriceFeedsResult> {
  "use step";

  const credentials = input.integrationId
    ? ((await fetchCredentials(input.integrationId, {
        organizationId: input._context?.organizationId ?? null,
      })) as PythCredentials)
    : {};

  return runPluginStep(
    { pluginName: "pyth", actionName: "search-price-feeds" },
    input,
    () => stepHandler(input, credentials)
  );
}

export const _integrationType = "pyth";
