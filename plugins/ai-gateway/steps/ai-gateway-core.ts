import "server-only";

import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import { safeFetch } from "@/lib/safe-fetch";

const AI_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh/v1";

export type AiGatewayFailure = {
  success: false;
  error: string;
  errorClass: ExecutionErrorType;
};

type AiGatewaySuccess = {
  success: true;
  data: unknown;
};

export type AiGatewayRequestResult = AiGatewaySuccess | AiGatewayFailure;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function providerErrorMessage(data: unknown): string | undefined {
  if (!isRecord(data)) {
    return;
  }

  if (typeof data.message === "string" && data.message.trim()) {
    return data.message;
  }

  if (typeof data.error === "string" && data.error.trim()) {
    return data.error;
  }

  if (isRecord(data.error) && typeof data.error.message === "string") {
    return data.error.message;
  }
}

async function readResponseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return;
  }
}

export async function requestAiGateway(
  path: "/chat/completions" | "/images/generations",
  apiKey: string,
  body: Record<string, unknown>
): Promise<AiGatewayRequestResult> {
  try {
    const response = await safeFetch(`${AI_GATEWAY_BASE_URL}${path}`, {
      plugin: "ai-gateway",
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const data = await readResponseJson(response);

    if (!response.ok) {
      return {
        success: false,
        error:
          providerErrorMessage(data) ??
          `AI Gateway request failed with HTTP ${response.status}.`,
        errorClass:
          response.status >= 500
            ? ExecutionErrorType.EXTERNAL
            : ExecutionErrorType.USER,
      };
    }

    if (data === undefined) {
      return {
        success: false,
        error: "AI Gateway returned a malformed JSON response.",
        errorClass: ExecutionErrorType.EXTERNAL,
      };
    }

    return { success: true, data };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `AI Gateway request failed: ${message}`,
      errorClass: ExecutionErrorType.EXTERNAL,
    };
  }
}
