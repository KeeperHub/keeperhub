import "server-only";

import { fetchCredentials } from "@/lib/credential-fetcher";
import {
  runPluginStep,
  type StepInput,
} from "@/lib/workflow/executor/step-handler";
import type { AiGatewayCredentials } from "../credentials";
import {
  type GenerateImageCoreInput,
  type GenerateImageResult,
  generateImage,
} from "./generate-image-core";

export type {
  GenerateImageCoreInput,
  GenerateImageResult,
} from "./generate-image-core";

export type GenerateImageInput = StepInput &
  GenerateImageCoreInput & {
    integrationId?: string;
  };

async function stepHandler(
  input: GenerateImageCoreInput,
  credentials: AiGatewayCredentials
): Promise<GenerateImageResult> {
  return await generateImage(input, credentials);
}

export async function generateImageStep(
  input: GenerateImageInput
): Promise<GenerateImageResult> {
  "use step";

  const credentials = input.integrationId
    ? await fetchCredentials(input.integrationId, {
        organizationId: input._context?.organizationId ?? null,
      })
    : {};

  return runPluginStep(
    { pluginName: "ai-gateway", actionName: "generate-image" },
    input,
    (stepInput) => stepHandler(stepInput, credentials)
  );
}
generateImageStep.maxRetries = 0;

export const _integrationType = "ai-gateway";
