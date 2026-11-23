import "server-only";

import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import {
  runPluginStep,
  type StepInput,
} from "@/lib/workflow/executor/step-handler";
import {
  AGENT_URL_ERROR,
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
    return failure(AGENT_URL_ERROR, ExecutionErrorType.USER);
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

  const card = readAgentCard(parseJson(text));
  if (!card) {
    return failure(
      `${url} is not a Lucid agent card: it has no entrypoints object`,
      ExecutionErrorType.USER,
      response.status
    );
  }

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
