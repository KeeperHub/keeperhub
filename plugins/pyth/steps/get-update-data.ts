import "server-only";

import { safeFetch } from "@/lib/safe-fetch";
import { getErrorMessage } from "@/lib/utils";
import { type StepInput, withStepLogging } from "@/lib/workflow/executor/step-handler";
import { resolvePythFeedId } from "./get-price";

export type GetPythUpdateDataResult =
  | {
      success: true;
      updateData: string[];
      encoding: "hex" | "base64";
      feedIds: string[];
      updateDataCount: number;
    }
  | { success: false; error: string };

export type GetPythUpdateDataCoreInput = {
  feedIds: string;
  encoding?: "hex" | "base64";
};

export type GetPythUpdateDataInput = StepInput & GetPythUpdateDataCoreInput;

async function stepHandler(
  input: GetPythUpdateDataCoreInput
): Promise<GetPythUpdateDataResult> {
  if (!input.feedIds || input.feedIds.trim() === "") {
    return {
      success: false,
      error: "At least one Pyth feed ID or symbol is required.",
    };
  }

  const rawList = input.feedIds.split(",").map((s) => s.trim()).filter(Boolean);
  const resolvedIds = rawList.map((item) => resolvePythFeedId(item));
  const encoding = input.encoding ?? "hex";

  try {
    const queryParams = new URLSearchParams();
    queryParams.append("encoding", encoding);
    for (const id of resolvedIds) {
      queryParams.append("ids[]", id);
    }

    const url = `https://hermes.pyth.network/v2/updates/price/latest?${queryParams.toString()}`;

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
        error: `Pyth Hermes API returned status ${response.status}: ${response.statusText}`,
      };
    }

    const json = (await response.json()) as {
      binary?: {
        encoding: string;
        data: string[];
      };
    };

    if (!json.binary || !Array.isArray(json.binary.data) || json.binary.data.length === 0) {
      return {
        success: false,
        error: "No binary price update data returned from Pyth Hermes API.",
      };
    }

    const formattedData = json.binary.data.map((item) => {
      if (encoding === "hex" && !item.startsWith("0x")) {
        return `0x${item}`;
      }
      return item;
    });

    return {
      success: true,
      updateData: formattedData,
      encoding,
      feedIds: resolvedIds,
      updateDataCount: formattedData.length,
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to fetch Pyth update data: ${getErrorMessage(error)}`,
    };
  }
}

export async function getUpdateDataStep(
  input: GetPythUpdateDataInput
): Promise<GetPythUpdateDataResult> {
  "use step";

  return withStepLogging(input, () => stepHandler(input));
}

export const _integrationType = "pyth";
