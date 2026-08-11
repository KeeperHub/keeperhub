import "server-only";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";

import { fetchCredentials } from "@/lib/credential-fetcher";
import { safeFetch } from "@/lib/safe-fetch";
import { type StepInput, withStepLogging } from "@/lib/workflow/executor/step-handler";
import { getErrorMessage } from "@/lib/utils";
import type { WebflowCredentials } from "../credentials";

const WEBFLOW_API_URL = "https://api.webflow.com/v2";

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

type GetSiteResult =
  | { success: true; data: GetSiteData }
  | {
      success: false;
      error: { message: string };
      errorClass?: ExecutionErrorType;
    };

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
  const apiKey = credentials.WEBFLOW_API_KEY;

  if (!apiKey) {
    return {
      success: false,
      error: {
        message:
          "WEBFLOW_API_KEY is not configured. Please add it in Project Integrations.",
      },
      errorClass: ExecutionErrorType.USER,
    };
  }

  if (!input.siteId) {
    return {
      success: false,
      error: { message: "Site ID is required" },
      errorClass: ExecutionErrorType.USER,
    };
  }

  try {
    const response = await safeFetch(
      `${WEBFLOW_API_URL}/sites/${encodeURIComponent(input.siteId)}`,
      {
        plugin: "webflow",
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
      }
    );

    if (!response.ok) {
      const errorData = (await response.json()) as { message?: string };
      return {
        success: false,
        error: { message: errorData.message || `HTTP ${response.status}` },
        errorClass: response.status >= 500 ? ExecutionErrorType.EXTERNAL : ExecutionErrorType.USER,
      };
    }

    const site = (await response.json()) as WebflowSiteResponse;

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
