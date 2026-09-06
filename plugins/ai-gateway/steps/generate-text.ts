import "server-only";

import { fetchCredentials } from "@/lib/credential-fetcher";
import {
  runPluginStep,
  type StepInput,
} from "@/lib/workflow/executor/step-handler";
import type { AiGatewayCredentials } from "../credentials";
import {
  type GenerateTextCoreInput,
  type GenerateTextResult,
  generateText,
} from "./generate-text-core";

export type {
  GenerateTextCoreInput,
  GenerateTextResult,
  SchemaField,
} from "./generate-text-core";

export type GenerateTextInput = StepInput &
  GenerateTextCoreInput & {
    integrationId?: string;
  };

async function stepHandler(
  input: GenerateTextCoreInput,
  credentials: AiGatewayCredentials
): Promise<GenerateTextResult> {
  return await generateText(input, credentials);
}

export async function generateTextStep(
  input: GenerateTextInput
): Promise<GenerateTextResult> {
  "use step";

  const credentials = input.integrationId
    ? await fetchCredentials(input.integrationId, {
        organizationId: input._context?.organizationId ?? null,
      })
    : {};

  return runPluginStep(
    { pluginName: "ai-gateway", actionName: "generate-text" },
    input,
    (stepInput) => stepHandler(stepInput, credentials)
  );
}
generateTextStep.maxRetries = 0;

export const _integrationType = "ai-gateway";
