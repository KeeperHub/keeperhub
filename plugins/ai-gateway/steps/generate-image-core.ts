import "server-only";

import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import type { AiGatewayCredentials } from "../credentials";
import {
  type AiGatewayFailure,
  isRecord,
  requestAiGateway,
} from "./ai-gateway-core";

const DEFAULT_IMAGE_MODEL = "google/imagen-4.0-generate-001";

export type GenerateImageCoreInput = {
  imageModel?: string;
  imagePrompt?: string;
};

export type GenerateImageResult =
  | { success: true; base64: string }
  | AiGatewayFailure;

function userFailure(error: string): AiGatewayFailure {
  return { success: false, error, errorClass: ExecutionErrorType.USER };
}

function extractBase64(data: unknown): string | undefined {
  if (!isRecord(data) || !Array.isArray(data.data)) {
    return;
  }
  const firstImage = data.data[0];
  if (!isRecord(firstImage) || typeof firstImage.b64_json !== "string") {
    return;
  }
  const base64 = firstImage.b64_json.trim();
  return base64 || undefined;
}

export async function generateImage(
  input: GenerateImageCoreInput,
  credentials: AiGatewayCredentials
): Promise<GenerateImageResult> {
  const apiKey = credentials.AI_GATEWAY_API_KEY;
  if (!apiKey) {
    return userFailure(
      "AI_GATEWAY_API_KEY is not configured. Please add it in Project Integrations."
    );
  }

  const prompt =
    typeof input.imagePrompt === "string" ? input.imagePrompt.trim() : "";
  if (!prompt) {
    return userFailure("Prompt is required for image generation.");
  }

  const model = (input.imageModel ?? DEFAULT_IMAGE_MODEL).trim();
  if (!model) {
    return userFailure("Model is required for image generation.");
  }

  const response = await requestAiGateway("/images/generations", apiKey, {
    model,
    prompt,
    size: "1024x1024",
    response_format: "b64_json",
  });
  if (!response.success) {
    return response;
  }

  const base64 = extractBase64(response.data);
  if (!base64) {
    return {
      success: false,
      error: "AI Gateway returned a malformed image-generation response.",
      errorClass: ExecutionErrorType.EXTERNAL,
    };
  }

  return { success: true, base64 };
}
