import "server-only";

import { fetchCredentials } from "@/lib/credential-fetcher";
import { safeFetch } from "@/lib/safe-fetch";
import { getErrorMessage } from "@/lib/utils";
import { runPluginStep, type StepInput } from "@/lib/workflow/executor/step-handler";
import type { PythCredentials } from "../credentials";
import {
  getPythBaseUrl,
  getPythHeaders,
  resolvePythFeedId,
} from "./pyth-core";

export type GetPythUpdateDataResult =
  | {
      success: true;
      updateData: string[];
      encoding: string;
      feedIds: string[];
      updateDataCount: number;
    }
  | { success: false; error: string };

export type GetPythUpdateDataCoreInput = {
  feedIds: string;
  encoding?: "hex" | "base64";
};

export type GetPythUpdateDataInput = StepInput &
  GetPythUpdateDataCoreInput & {
    integrationId?: string;
  };

async function stepHandler(
  input: GetPythUpdateDataInput,
  credentials: PythCredentials
): Promise<GetPythUpdateDataResult> {
  if (!input.feedIds || input.feedIds.trim() === "") {
    return {
      success: false,
      error: "At least one Pyth feed ID or symbol is required.",
    };
  }

  const apiKey = credentials.PYTH_API_KEY;
  const endpointUrl = credentials.PYTH_ENDPOINT_URL;

  const rawList = input.feedIds.split(",").map((s) => s.trim()).filter(Boolean);
  const resolvedIds: string[] = [];
  for (const item of rawList) {
    resolvedIds.push(await resolvePythFeedId(item, apiKey, endpointUrl));
  }

  const requestedEncoding = input.encoding ?? "hex";

  try {
    const baseUrl = getPythBaseUrl(endpointUrl);
    const headers = getPythHeaders(apiKey);

    const queryParams = new URLSearchParams();
    queryParams.append("encoding", requestedEncoding);
    for (const id of resolvedIds) {
      queryParams.append("ids[]", id);
    }

    const url = `${baseUrl}/v2/updates/price/latest?${queryParams.toString()}`;

    const response = await safeFetch(url, {
      plugin: "pyth",
      method: "GET",
      headers,
    });

    if (!response.ok) {
      const statusMsg = response.statusText ? ` ${response.statusText}` : "";
      return {
        success: false,
        error: `Pyth Hermes API returned status ${response.status}${statusMsg}`,
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

    const actualEncoding = json.binary.encoding || requestedEncoding;

    const formattedData = json.binary.data.map((item) => {
      if (actualEncoding === "hex" && !item.startsWith("0x") && !item.startsWith("0X")) {
        return `0x${item}`;
      }
      return item;
    });

    return {
      success: true,
      updateData: formattedData,
      encoding: actualEncoding,
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

  const credentials = input.integrationId
    ? ((await fetchCredentials(input.integrationId, {
        organizationId: input._context?.organizationId ?? null,
      })) as PythCredentials)
    : {};

  return runPluginStep(
    { pluginName: "pyth", actionName: "get-update-data" },
    input,
    () => stepHandler(input, credentials)
  );
}

export const _integrationType = "pyth";
