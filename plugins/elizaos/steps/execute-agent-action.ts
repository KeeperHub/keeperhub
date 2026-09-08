import "server-only";

import { fetchCredentials } from "@/lib/credential-fetcher";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import { assertUrlIsPublic, safeFetch, SsrfBlockedError } from "@/lib/safe-fetch";
import { getErrorMessage } from "@/lib/utils";
import {
  runPluginStep,
  type StepInput,
} from "@/lib/workflow/executor/step-handler";
import type { ElizaOSCredentials } from "../credentials";

const TRAILING_SLASH_RE = /\/+$/;

export type ExecuteAgentActionResult =
  | {
      success: true;
      response: string;
    }
  | {
      success: false;
      error: string;
      errorClass?: ExecutionErrorType;
    };

export type ExecuteAgentActionCoreInput = {
  action: string;
  payload?: string | Record<string, unknown>;
  agentId?: string;
  path?: string;
};

export type ExecuteAgentActionInput = StepInput &
  ExecuteAgentActionCoreInput & {
    integrationId?: string;
  };

async function stepHandler(
  input: ExecuteAgentActionCoreInput,
  credentials: ElizaOSCredentials
): Promise<ExecuteAgentActionResult> {
  const rawUrl = credentials.ELIZAOS_ENDPOINT_URL?.trim();
  if (!rawUrl) {
    return {
      success: false,
      error: "ELIZAOS_ENDPOINT_URL is not configured. Please add it in Project Integrations.",
      errorClass: ExecutionErrorType.USER,
    };
  }

  const action = input.action?.trim();
  if (!action) {
    return {
      success: false,
      error: "Action name is required.",
      errorClass: ExecutionErrorType.USER,
    };
  }

  const baseUrl = rawUrl.replace(TRAILING_SLASH_RE, "");
  const agentId = input.agentId?.trim() || credentials.ELIZAOS_AGENT_ID?.trim() || "default";

  let parsedPayload: Record<string, unknown> = {};
  if (input.payload) {
    if (typeof input.payload === "object" && input.payload !== null) {
      parsedPayload = input.payload as Record<string, unknown>;
    } else if (typeof input.payload === "string" && input.payload.trim()) {
      try {
        parsedPayload = JSON.parse(input.payload);
      } catch (err) {
        return {
          success: false,
          error: `Invalid JSON in payload: ${getErrorMessage(err)}`,
          errorClass: ExecutionErrorType.USER,
        };
      }
    }
  }

  // Resolve target endpoint path:
  // Allows user-configured path (e.g. /api/agent/action for v2, or custom plugin route),
  // with optional {agentId} token interpolation. Defaults to /api/agents/{agentId}/action.
  let resolvedPath: string;
  if (input.path?.trim()) {
    resolvedPath = input.path.trim().replace("{agentId}", encodeURIComponent(agentId));
  } else if (agentId && agentId !== "default") {
    resolvedPath = `/api/agents/${encodeURIComponent(agentId)}/action`;
  } else {
    resolvedPath = "/api/agents/default/action";
  }

  if (!resolvedPath.startsWith("/")) {
    resolvedPath = `/${resolvedPath}`;
  }

  const fullUrl = `${baseUrl}${resolvedPath}`;

  try {
    // SSRF guard: endpointUrl is user-supplied on the integration and path is configurable,
    // so validate that destination does not point to link-local or RFC1918 internal networks
    // before any outbound request.
    await assertUrlIsPublic(fullUrl);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };

    if (credentials.ELIZAOS_API_KEY?.trim()) {
      headers.Authorization = `Bearer ${credentials.ELIZAOS_API_KEY.trim()}`;
    }

    const response = await safeFetch(fullUrl, {
      plugin: "elizaos",
      method: "POST",
      headers,
      body: JSON.stringify({
        action,
        payload: parsedPayload,
      }),
    });

    if (!response.ok) {
      const errorData = (await response.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      return {
        success: false,
        error:
          (typeof errorData.message === "string" && errorData.message) ||
          (typeof errorData.error === "string" && errorData.error) ||
          `HTTP ${response.status}: ElizaOS agent action failed`,
        errorClass:
          response.status >= 500
            ? ExecutionErrorType.EXTERNAL
            : ExecutionErrorType.USER,
      };
    }

    // Return the raw text representation of the response body to avoid swallowing text/plain
    const rawResponse = await response.text();
    return {
      success: true,
      response: rawResponse,
    };
  } catch (error) {
    if (error instanceof SsrfBlockedError) {
      return {
        success: false,
        error: `ElizaOS instance URL is not allowed: ${error.message}`,
        errorClass: ExecutionErrorType.USER,
      };
    }

    return {
      success: false,
      error: `Failed to execute ElizaOS agent action: ${getErrorMessage(error)}`,
      errorClass: ExecutionErrorType.EXTERNAL,
    };
  }
}

export async function executeAgentActionStep(
  input: ExecuteAgentActionInput
): Promise<ExecuteAgentActionResult> {
  "use step";

  const credentials = input.integrationId
    ? await fetchCredentials(input.integrationId, {
        organizationId: input._context?.organizationId ?? null,
      })
    : {};

  return runPluginStep(
    { pluginName: "elizaos", actionName: "execute-agent-action" },
    input,
    () => stepHandler(input, credentials)
  );
}

export const _integrationType = "elizaos";
