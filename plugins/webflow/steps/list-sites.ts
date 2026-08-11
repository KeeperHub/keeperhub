import "server-only";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";

import { fetchCredentials } from "@/lib/credential-fetcher";
import { safeFetch } from "@/lib/safe-fetch";
import { type StepInput, withStepLogging } from "@/lib/workflow/executor/step-handler";
import { getErrorMessage } from "@/lib/utils";
import type { WebflowCredentials } from "../credentials";

const WEBFLOW_API_URL = "https://api.webflow.com/v2";

type WebflowSite = {
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

type SiteData = {
  id: string;
  displayName: string;
  shortName: string;
  previewUrl: string;
  lastPublished?: string;
  lastUpdated: string;
  customDomains: string[];
};

type ListSitesResult =
  | { success: true; data: { sites: SiteData[]; count: number } }
  | {
      success: false;
      error: { message: string };
      errorClass?: ExecutionErrorType;
    };

export type ListSitesCoreInput = Record<string, never>;

export type ListSitesInput = StepInput &
  ListSitesCoreInput & {
    integrationId?: string;
  };

async function stepHandler(
  _input: ListSitesCoreInput,
  credentials: WebflowCredentials
): Promise<ListSitesResult> {
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

  try {
    const response = await safeFetch(`${WEBFLOW_API_URL}/sites`, {
      plugin: "webflow",
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
    });

    if (!response.ok) {
      const errorData = (await response.json()) as { message?: string };
      return {
        success: false,
        error: { message: errorData.message || `HTTP ${response.status}` },
        errorClass: response.status >= 500 ? ExecutionErrorType.EXTERNAL : ExecutionErrorType.USER,
      };
    }

    const data = (await response.json()) as { sites: WebflowSite[] };

    const sites = data.sites.map((site) => ({
      id: site.id,
      displayName: site.displayName,
      shortName: site.shortName,
      previewUrl: site.previewUrl,
      lastPublished: site.lastPublished,
      lastUpdated: site.lastUpdated,
      customDomains: site.customDomains?.map((d) => d.url) || [],
    }));

    return {
      success: true,
      data: { sites, count: sites.length },
    };
  } catch (error) {
    return {
      success: false,
      error: { message: `Failed to list sites: ${getErrorMessage(error)}` },
      errorClass: ExecutionErrorType.EXTERNAL,
    };
  }
}

export async function listSitesStep(
  input: ListSitesInput
): Promise<ListSitesResult> {
  "use step";

  const credentials = input.integrationId
    ? await fetchCredentials(input.integrationId, { organizationId: input._context?.organizationId ?? null })
    : {};

  return withStepLogging(input, () => stepHandler(input, credentials));
}
listSitesStep.maxRetries = 0;

export const _integrationType = "webflow";
