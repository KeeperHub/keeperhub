import "server-only";

import { safeFetch } from "@/lib/safe-fetch";
import { getErrorMessage } from "@/lib/utils";
import { type StepInput, withStepLogging } from "@/lib/workflow/executor/step-handler";

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
      count: number;
    }
  | { success: false; error: string };

export type SearchPythPriceFeedsCoreInput = {
  query?: string;
  assetType?: string;
};

export type SearchPythPriceFeedsInput = StepInput & SearchPythPriceFeedsCoreInput;

async function stepHandler(
  input: SearchPythPriceFeedsCoreInput
): Promise<SearchPythPriceFeedsResult> {
  try {
    const queryParams = new URLSearchParams();
    if (input.query && input.query.trim() !== "") {
      queryParams.append("query", input.query.trim());
    }
    if (input.assetType && input.assetType.trim() !== "") {
      queryParams.append("asset_type", input.assetType.trim());
    }

    const url = `https://hermes.pyth.network/v2/price_feeds?${queryParams.toString()}`;

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

    const json = (await response.json()) as Array<{
      id: string;
      attributes?: {
        symbol?: string;
        asset_type?: string;
        base?: string;
        quote_currency?: string;
      };
    }>;

    if (!Array.isArray(json)) {
      return {
        success: false,
        error: "Invalid price feeds format returned from Pyth API.",
      };
    }

    const feeds: PythFeedMetaData[] = json.slice(0, 50).map((item) => {
      const feedId = item.id.startsWith("0x") ? item.id : `0x${item.id}`;
      return {
        id: feedId,
        symbol: item.attributes?.symbol ?? "Unknown",
        assetType: item.attributes?.asset_type ?? "crypto",
        base: item.attributes?.base ?? "",
        quote: item.attributes?.quote_currency ?? "USD",
      };
    });

    return {
      success: true,
      feeds,
      count: feeds.length,
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

  return withStepLogging(input, () => stepHandler(input));
}

export const _integrationType = "pyth";
