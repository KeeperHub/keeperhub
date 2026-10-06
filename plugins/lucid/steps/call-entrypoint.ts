import "server-only";

import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import { getErrorMessage } from "@/lib/utils";
import {
  runPluginStep,
  type StepInput,
} from "@/lib/workflow/executor/step-handler";
import {
  AGENT_URL_ERROR,
  CHALLENGE_HEADERS,
  failure,
  httpFailure,
  INVOKE_TIMEOUT_MS,
  isFailure,
  isObject,
  type LucidFailure,
  lucidFetch,
  normalizeAgentUrl,
  type PaymentTerms,
  parseJson,
  readHeaderJson,
  readPaymentTerms,
} from "./lucid-core";

/**
 * The only run status a Lucid agent reports on a 2xx invoke. Its own types
 * admit "failed" and "cancelled" alongside it, and the A2A client types the
 * field as an open string, so anything else is read as a run that did not
 * succeed rather than guessed at.
 */
const RUN_SUCCEEDED = "succeeded";

/** A failure that still carries what the agent said about its run. */
export type CallEntrypointFailure = LucidFailure & {
  agentStatus?: string;
  runId?: string;
};

export type CallEntrypointResult =
  | {
      success: true;
      status: "completed";
      httpStatus: number;
      output: unknown;
      /** The run status the agent reported, when it reported one. */
      agentStatus?: string;
      /** The agent's id for this run, when it returns one. */
      runId?: string;
    }
  | {
      success: true;
      // Not "payment_required": the Condition validator rejects any literal
      // containing "require", so that value could not be branched on.
      status: "awaiting_payment";
      httpStatus: 402;
      /** First accepted payment requirement, or null if none could be read. */
      payment: PaymentTerms | null;
      /** The full 402 challenge as served. */
      challenge: unknown;
    }
  | CallEntrypointFailure;

export type CallEntrypointCoreInput = {
  agentUrl: string;
  entrypoint: string;
  input?: string | Record<string, unknown>;
};

export type CallEntrypointInput = StepInput & CallEntrypointCoreInput;

function parseInput(
  raw: CallEntrypointCoreInput["input"]
): Record<string, unknown> | LucidFailure {
  if (raw === undefined || raw === null || raw === "") {
    return {};
  }
  if (typeof raw === "object") {
    return isObject(raw)
      ? raw
      : failure("Input must be a JSON object", ExecutionErrorType.USER);
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isObject(parsed)) {
      return parsed;
    }
    return failure("Input must be a JSON object", ExecutionErrorType.USER);
  } catch (error) {
    return failure(
      `Invalid JSON in input: ${getErrorMessage(error)}`,
      ExecutionErrorType.USER
    );
  }
}

type InvokeResult = {
  output: unknown;
  runId?: string;
  agentStatus?: string;
  detail?: string;
};

/** The agent's own account of why the run did not succeed, when it gives one. */
function readRunError(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (!isObject(value)) {
    return;
  }
  const message = typeof value.message === "string" ? value.message : undefined;
  const code = typeof value.code === "string" ? value.code : undefined;
  return [code, message].filter(Boolean).join(": ") || undefined;
}

/**
 * A Lucid invoke answers 2xx with `{ run_id, status, output }`. Anything else
 * is not an entrypoint result, however successful the HTTP status looks.
 */
function readInvokeResult(parsed: unknown): InvokeResult | undefined {
  if (!(isObject(parsed) && "output" in parsed)) {
    return;
  }
  return {
    output: parsed.output,
    runId: typeof parsed.run_id === "string" ? parsed.run_id : undefined,
    agentStatus: typeof parsed.status === "string" ? parsed.status : undefined,
    detail: readRunError(parsed.error),
  };
}

async function stepHandler(
  input: CallEntrypointCoreInput
): Promise<CallEntrypointResult> {
  const agentUrl = normalizeAgentUrl(input.agentUrl);
  if (!agentUrl) {
    return failure(AGENT_URL_ERROR, ExecutionErrorType.USER);
  }
  const entrypoint = input.entrypoint?.trim();
  if (!entrypoint) {
    return failure("Entrypoint is required", ExecutionErrorType.USER);
  }
  const body = parseInput(input.input);
  if (isFailure(body)) {
    return body;
  }

  const url = `${agentUrl}/entrypoints/${encodeURIComponent(entrypoint)}/invoke`;
  const response = await lucidFetch(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ input: body }),
    },
    INVOKE_TIMEOUT_MS
  );
  if (isFailure(response)) {
    return response;
  }

  const text = await response.text();
  const parsed = parseJson(text);

  if (response.status === 402) {
    // Lucid agents send an empty body and the terms in a base64 header;
    // other x402 servers put them in the body. Both are read.
    const challenge =
      readHeaderJson(response.headers, CHALLENGE_HEADERS) ?? parsed;
    return {
      success: true,
      status: "awaiting_payment",
      httpStatus: 402,
      payment: readPaymentTerms(challenge),
      challenge: challenge ?? text,
    };
  }

  if (!response.ok) {
    return httpFailure(`Entrypoint ${entrypoint} failed`, response, text);
  }

  const result = readInvokeResult(parsed);
  if (!result) {
    return failure(
      `${url} answered HTTP ${response.status} without an entrypoint result; is ${agentUrl} a Lucid agent?`,
      ExecutionErrorType.USER,
      response.status
    );
  }

  // An agent that names its own run anything but succeeded has not produced a
  // result, so the step fails rather than publishing status "completed".
  if (
    result.agentStatus !== undefined &&
    result.agentStatus !== RUN_SUCCEEDED
  ) {
    const detail = result.detail ? `: ${result.detail}` : "";
    return Object.assign(
      failure(
        `Entrypoint ${entrypoint} reported run status "${result.agentStatus}"${detail}`,
        ExecutionErrorType.EXTERNAL,
        response.status
      ),
      { agentStatus: result.agentStatus, runId: result.runId }
    );
  }

  return {
    success: true,
    status: "completed",
    httpStatus: response.status,
    output: result.output,
    agentStatus: result.agentStatus,
    runId: result.runId,
  };
}

/**
 * Call Lucid Entrypoint Step
 * Invokes one entrypoint. A priced entrypoint returns its x402 terms as data;
 * this step never signs or pays.
 */
export async function callEntrypointStep(
  input: CallEntrypointInput
): Promise<CallEntrypointResult> {
  "use step";

  return runPluginStep(
    { pluginName: "lucid", actionName: "call-entrypoint" },
    input,
    stepHandler
  );
}

// An invoke is not idempotent: a retry would run the entrypoint again.
callEntrypointStep.maxRetries = 0;

export const _integrationType = "lucid";
