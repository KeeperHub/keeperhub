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

type PublishResponse = {
  customDomains?: Array<{
    id: string;
    url: string;
    lastPublished?: string;
  }>;
  publishToWebflowSubdomain?: boolean;
};

type PublishSiteResult =
  | {
      success: true;
      data: { publishedDomains: string[]; publishedToSubdomain: boolean };
    }
  | WebflowFailure;

export type PublishSiteCoreInput = {
  siteId: string;
  publishToWebflowSubdomain?: string;
  customDomainIds?: string;
};

export type PublishSiteInput = StepInput &
  PublishSiteCoreInput & {
    integrationId?: string;
  };

async function stepHandler(
  input: PublishSiteCoreInput,
  credentials: WebflowCredentials
): Promise<PublishSiteResult> {
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
    const body: {
      publishToWebflowSubdomain?: boolean;
      customDomains?: string[];
    } = {};

    // Parse custom domain IDs if provided
    const customDomains = input.customDomainIds
      ? input.customDomainIds
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean)
      : [];

    if (customDomains.length > 0) {
      body.customDomains = customDomains;
    }

    // Default to publishing to subdomain if no custom domains specified
    // or if explicitly set to true
    const publishToSubdomain =
      input.publishToWebflowSubdomain === "false" ? false : true;

    if (publishToSubdomain || customDomains.length === 0) {
      body.publishToWebflowSubdomain = true;
    } else {
      body.publishToWebflowSubdomain = false;
    }

    const fetchResult = await webflowFetch(
      `${WEBFLOW_API_URL}/sites/${encodeURIComponent(input.siteId)}/publish`,
      {
        apiKey: keyResult.apiKey,
        method: "POST",
        body: JSON.stringify(body),
      }
    );

    if ("error" in fetchResult) {
      return fetchResult;
    }

    const result = (await fetchResult.response.json()) as PublishResponse;

    return {
      success: true,
      data: {
        publishedDomains: result.customDomains?.map((d) => d.url) || [],
        publishedToSubdomain: result.publishToWebflowSubdomain ?? false,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: { message: `Failed to publish site: ${getErrorMessage(error)}` },
      errorClass: ExecutionErrorType.EXTERNAL,
    };
  }
}

export async function publishSiteStep(
  input: PublishSiteInput
): Promise<PublishSiteResult> {
  "use step";

  const credentials = input.integrationId
    ? await fetchCredentials(input.integrationId, { organizationId: input._context?.organizationId ?? null })
    : {};

  return withStepLogging(input, () => stepHandler(input, credentials));
}
publishSiteStep.maxRetries = 0;

export const _integrationType = "webflow";
