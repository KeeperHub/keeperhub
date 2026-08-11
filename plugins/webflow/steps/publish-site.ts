import "server-only";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";

import { fetchCredentials } from "@/lib/credential-fetcher";
import { safeFetch } from "@/lib/safe-fetch";
import { type StepInput, withStepLogging } from "@/lib/workflow/executor/step-handler";
import { getErrorMessage } from "@/lib/utils";
import type { WebflowCredentials } from "../credentials";

const WEBFLOW_API_URL = "https://api.webflow.com/v2";

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
  | {
      success: false;
      error: { message: string };
      errorClass?: ExecutionErrorType;
    };

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

    const response = await safeFetch(
      `${WEBFLOW_API_URL}/sites/${encodeURIComponent(input.siteId)}/publish`,
      {
        plugin: "webflow",
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
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

    const result = (await response.json()) as PublishResponse;

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
