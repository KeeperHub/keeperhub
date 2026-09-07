import "server-only";

import { fetchCredentials } from "@/lib/credential-fetcher";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import { safeFetch } from "@/lib/safe-fetch";
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

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };

    if (credentials.ELIZAOS_API_KEY?.trim()) {
      headers.Authorization = `Bearer ${credentials.ELIZAOS_API_KEY.trim()}`;
    }

    const response = await safeFetch(
      `${baseUrl}/api/agents/${encodeURIComponent(agentId)}/action`,
      {
        plugin: "elizaos",
        method: "POST",
        headers,
        body: JSON.stringify({
          action,
          payload: parsedPayload,
        }),
      }
    );

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

    const data = await response.json().catch(() => ({}));
    return {
      success: true,
      response: typeof data === "string" ? data : JSON.stringify(data),
    };
  } catch (error) {
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
