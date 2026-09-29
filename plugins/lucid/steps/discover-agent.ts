import "server-only";

import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import {
  runPluginStep,
  type StepInput,
} from "@/lib/workflow/executor/step-handler";
import {
  DISCOVER_TIMEOUT_MS,
  failure,
  httpFailure,
  isFailure,
  type LucidEntrypoint,
  type LucidFailure,
  lucidFetch,
  normalizeAgentUrl,
  parseJson,
  readAgentCard,
} from "./lucid-core";

export type DiscoverAgentResult =
  | {
      success: true;
      name: string;
      version?: string;
      description?: string;
      entrypoints: LucidEntrypoint[];
      pricedEntrypoints: string[];
      extensions: string[];
    }
  | LucidFailure;

export type DiscoverAgentCoreInput = {
  agentUrl: string;
};

export type DiscoverAgentInput = StepInput & DiscoverAgentCoreInput;

async function stepHandler(
  input: DiscoverAgentCoreInput
): Promise<DiscoverAgentResult> {
  const agentUrl = normalizeAgentUrl(input.agentUrl);
  if (!agentUrl) {
    return failure(
      "Agent URL must be an absolute http(s) URL, e.g. https://agent.example.com",
      ExecutionErrorType.USER
    );
  }

  const url = `${agentUrl}/.well-known/agent-card.json`;
  const response = await lucidFetch(
    url,
    { method: "GET", headers: { Accept: "application/json" } },
    DISCOVER_TIMEOUT_MS
  );
  if (isFailure(response)) {
    return response;
  }

  const text = await response.text();
  if (!response.ok) {
    return httpFailure("Agent card unavailable", response, text);
  }

  const payload = parseJson(text);
  if (payload === null) {
    return failure(
      `Agent card at ${url} is not JSON`,
      ExecutionErrorType.USER,
      response.status
    );
  }

  const card = readAgentCard(payload);
  return {
    success: true,
    ...card,
    pricedEntrypoints: card.entrypoints
      .filter((entrypoint) => entrypoint.priced)
      .map((entrypoint) => entrypoint.name),
  };
}

/**
 * Discover Lucid Agent Step
 * Reads a Lucid agent's card and lists its entrypoints with their prices.
 */
export async function discoverAgentStep(
  input: DiscoverAgentInput
): Promise<DiscoverAgentResult> {
  "use step";

  return runPluginStep(
    { pluginName: "lucid", actionName: "discover-agent" },
    input,
    stepHandler
  );
}

export const _integrationType = "lucid";
