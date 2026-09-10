import "server-only";

import { randomUUID } from "node:crypto";
import { fetchCredentials } from "@/lib/credential-fetcher";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import { assertUrlIsPublic, safeFetch, SsrfBlockedError } from "@/lib/safe-fetch";
import { getErrorMessage } from "@/lib/utils";
import {
  runPluginStep,
  type StepInput,
} from "@/lib/workflow/executor/step-handler";
import type { ElizaOSCredentials } from "../credentials";

// The instance URL is user-supplied and the default flow makes two sequential
// calls, so a hung server would otherwise hold the step open on both.
const FETCH_TIMEOUT_MS = 10_000;

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
  agentId?: string;
  payload?: string | Record<string, unknown>;
  userId?: string;
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
  const agentId = input.agentId?.trim() || credentials.ELIZAOS_AGENT_ID?.trim();
  if (!agentId) {
    return {
      success: false,
      error: "Agent ID is required. Please specify a valid agent UUID.",
      errorClass: ExecutionErrorType.USER,
    };
  }

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

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  if (credentials.ELIZAOS_API_KEY?.trim()) {
    headers.Authorization = `Bearer ${credentials.ELIZAOS_API_KEY.trim()}`;
  }

  try {
    // Mode 1: Custom endpoint path provided (for plugin-mounted routes or custom APIs)
    if (input.path?.trim()) {
      let resolvedPath = input.path.trim().replaceAll("{agentId}", encodeURIComponent(agentId));
      if (!resolvedPath.startsWith("/")) {
        resolvedPath = `/${resolvedPath}`;
      }
      const fullUrl = `${baseUrl}${resolvedPath}`;

      // SSRF guard: ensure public destination before egress
      await assertUrlIsPublic(fullUrl);

      const response = await safeFetch(fullUrl, {
        plugin: "elizaos",
        method: "POST",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
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

      const rawResponse = await response.text();
      return {
        success: true,
        response: rawResponse,
      };
    }

    // Mode 2: Out-of-the-box default targeting the published ElizaOS v1 Sessions API:
    // Step A: POST /api/messaging/sessions with agentId (UUID) and userId (UUID)
    const sessionUrl = `${baseUrl}/api/messaging/sessions`;
    await assertUrlIsPublic(sessionUrl);

    const callerUserId = input.userId?.trim() || randomUUID();

    const sessionRes = await safeFetch(sessionUrl, {
      plugin: "elizaos",
      method: "POST",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers,
      body: JSON.stringify({
        agentId,
        userId: callerUserId,
      }),
    });

    if (!sessionRes.ok) {
      const errorData = (await sessionRes.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      return {
        success: false,
        error:
          (typeof errorData.message === "string" && errorData.message) ||
          (typeof errorData.error === "string" && errorData.error) ||
          `HTTP ${sessionRes.status}: Failed to create ElizaOS messaging session`,
        errorClass:
          sessionRes.status >= 500
            ? ExecutionErrorType.EXTERNAL
            : ExecutionErrorType.USER,
      };
    }

    const sessionData = (await sessionRes.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const sessionId =
      (typeof sessionData.id === "string" && sessionData.id) ||
      (typeof sessionData.sessionId === "string" && sessionData.sessionId) ||
      (typeof (sessionData.data as Record<string, unknown> | undefined)?.id === "string" &&
        ((sessionData.data as Record<string, unknown>).id as string)) ||
      (typeof (sessionData.session as Record<string, unknown> | undefined)?.id === "string" &&
        ((sessionData.session as Record<string, unknown>).id as string));

    if (!sessionId) {
      return {
        success: false,
        error: "Failed to obtain sessionId from ElizaOS session creation response.",
        errorClass: ExecutionErrorType.EXTERNAL,
      };
    }

    // Step B: POST /api/messaging/sessions/{sessionId}/messages with { content }
    const messageUrl = `${baseUrl}/api/messaging/sessions/${encodeURIComponent(sessionId)}/messages`;
    await assertUrlIsPublic(messageUrl);

    const contentText =
      typeof parsedPayload.text === "string" && parsedPayload.text
        ? parsedPayload.text
        : Object.keys(parsedPayload).length > 0
          ? `${action}: ${JSON.stringify(parsedPayload)}`
          : action;

    const content = {
      text: contentText,
      action,
      ...parsedPayload,
    };

    const messageRes = await safeFetch(messageUrl, {
      plugin: "elizaos",
      method: "POST",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers,
      body: JSON.stringify({
        content,
      }),
    });

    if (!messageRes.ok) {
      const errorData = (await messageRes.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      return {
        success: false,
        error:
          (typeof errorData.message === "string" && errorData.message) ||
          (typeof errorData.error === "string" && errorData.error) ||
          `HTTP ${messageRes.status}: Failed to dispatch message to ElizaOS session`,
        errorClass:
          messageRes.status >= 500
            ? ExecutionErrorType.EXTERNAL
            : ExecutionErrorType.USER,
      };
    }

    const rawResponse = await messageRes.text();
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
