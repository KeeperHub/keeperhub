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
  | WebflowFailure;

export type ListSitesCoreInput = Record<string, never>;

export type ListSitesInput = StepInput &
  ListSitesCoreInput & {
    integrationId?: string;
  };

async function stepHandler(
  _input: ListSitesCoreInput,
  credentials: WebflowCredentials
): Promise<ListSitesResult> {
  const keyResult = requireWebflowApiKey(credentials);
  if ("error" in keyResult) {
    return keyResult;
  }

  try {
    const result = await webflowFetch(`${WEBFLOW_API_URL}/sites`, {
      apiKey: keyResult.apiKey,
      method: "GET",
    });

    if ("error" in result) {
      return result;
    }

    const data = (await result.response.json()) as { sites: WebflowSite[] };

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
