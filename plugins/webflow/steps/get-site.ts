import "server-only";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";

import { fetchCredentials } from "@/lib/credential-fetcher";
import { type StepInput, withStepLogging } from "@/lib/workflow/executor/step-handler";
import { getErrorMessage } from "@/lib/utils";
import type { WebflowCredentials } from "../credentials";
import {
  requireWebflowApiKey,
  WEBFLOW_API_URL,
  type WebflowFailure,
  webflowFetch,
} from "./webflow-core";

type WebflowSiteResponse = {
  id: string;
  workspaceId: string;
  createdOn: string;
  displayName: string;
  shortName: string;
  lastPublished?: string;
  lastUpdated: string;
  previewUrl: string;
  timeZone: string;
  customDomains?: Array<{
    id: string;
    url: string;
    lastPublished?: string;
  }>;
};

type GetSiteData = {
  id: string;
  displayName: string;
  shortName: string;
  previewUrl: string;
  lastPublished?: string;
  lastUpdated: string;
  timeZone: string;
  customDomains: Array<{
    id: string;
    url: string;
    lastPublished?: string;
  }>;
};

type GetSiteResult = { success: true; data: GetSiteData } | WebflowFailure;

export type GetSiteCoreInput = {
  siteId: string;
};

export type GetSiteInput = StepInput &
  GetSiteCoreInput & {
    integrationId?: string;
  };

async function stepHandler(
  input: GetSiteCoreInput,
  credentials: WebflowCredentials
): Promise<GetSiteResult> {
  const keyResult = requireWebflowApiKey(credentials);
  if ("error" in keyResult) {
    return keyResult;
  }

  if (!input.siteId) {
    return {
      success: false,
      error: { message: "Site ID is required" },
      errorClass: ExecutionErrorType.USER,
    };
  }

  try {
    const result = await webflowFetch(
      `${WEBFLOW_API_URL}/sites/${encodeURIComponent(input.siteId)}`,
      {
        apiKey: keyResult.apiKey,
        method: "GET",
      }
    );

    if ("error" in result) {
      return result;
    }

    const site = (await result.response.json()) as WebflowSiteResponse;

    return {
      success: true,
      data: {
        id: site.id,
        displayName: site.displayName,
        shortName: site.shortName,
        previewUrl: site.previewUrl,
        lastPublished: site.lastPublished,
        lastUpdated: site.lastUpdated,
        timeZone: site.timeZone,
        customDomains: site.customDomains || [],
      },
    };
  } catch (error) {
    return {
      success: false,
      error: { message: `Failed to get site: ${getErrorMessage(error)}` },
      errorClass: ExecutionErrorType.EXTERNAL,
    };
  }
}

export async function getSiteStep(
  input: GetSiteInput
): Promise<GetSiteResult> {
  "use step";

  const credentials = input.integrationId
    ? await fetchCredentials(input.integrationId, { organizationId: input._context?.organizationId ?? null })
    : {};

  return withStepLogging(input, () => stepHandler(input, credentials));
}
getSiteStep.maxRetries = 0;

export const _integrationType = "webflow";
