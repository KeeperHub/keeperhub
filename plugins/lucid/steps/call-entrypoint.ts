import "server-only";

import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import { getErrorMessage } from "@/lib/utils";
import {
  runPluginStep,
  type StepInput,
} from "@/lib/workflow/executor/step-handler";
import {
  CHALLENGE_HEADERS,
  failure,
  httpFailure,
  INVOKE_TIMEOUT_MS,
  isFailure,
  type LucidFailure,
  lucidFetch,
  normalizeAgentUrl,
  type PaymentTerms,
  parseJson,
  readHeaderJson,
  readPaymentTerms,
  SETTLEMENT_HEADERS,
} from "./lucid-core";

export type CallEntrypointResult =
  | {
      success: true;
      status: "completed";
      httpStatus: number;
      output: unknown;
      paid: boolean;
      /** Decoded settlement receipt, when the agent returned one. */
      paymentResponse: unknown;
    }
  | {
      success: true;
      // Not "payment_required": the Condition validator rejects any literal
      // containing "require", so that value could not be branched on.
      status: "awaiting_payment";
      httpStatus: 402;
      /** First accepted payment requirement, or null if none could be read. */
      payment: PaymentTerms | null;
      /** The full 402 challenge as served, for a signer or audit record. */
      paymentRequired: unknown;
    }
  | LucidFailure;

export type CallEntrypointCoreInput = {
  agentUrl: string;
  entrypoint: string;
  input?: string | Record<string, unknown>;
  paymentHeader?: string;
};

export type CallEntrypointInput = StepInput & CallEntrypointCoreInput;

function parseInput(
  raw: CallEntrypointCoreInput["input"]
): Record<string, unknown> | LucidFailure {
  if (raw === undefined || raw === null || raw === "") {
    return {};
  }
  if (typeof raw === "object") {
    return raw;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return failure("Input must be a JSON object", ExecutionErrorType.USER);
  } catch (error) {
    return failure(
      `Invalid JSON in input: ${getErrorMessage(error)}`,
      ExecutionErrorType.USER
    );
  }
}

async function stepHandler(
  input: CallEntrypointCoreInput
): Promise<CallEntrypointResult> {
  const agentUrl = normalizeAgentUrl(input.agentUrl);
  if (!agentUrl) {
    return failure(
      "Agent URL must be an absolute http(s) URL, e.g. https://agent.example.com",
      ExecutionErrorType.USER
    );
  }
  const entrypoint = input.entrypoint?.trim();
  if (!entrypoint) {
    return failure("Entrypoint is required", ExecutionErrorType.USER);
  }
  const body = parseInput(input.input);
  if (isFailure(body)) {
    return body;
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  const paymentHeader = input.paymentHeader?.trim();
  if (paymentHeader) {
    // x402 v2 reads PAYMENT-SIGNATURE, v1 reads X-PAYMENT. Sending both lets
    // one signed payload reach either kind of server.
    headers["PAYMENT-SIGNATURE"] = paymentHeader;
    headers["X-PAYMENT"] = paymentHeader;
  }

  const url = `${agentUrl}/entrypoints/${encodeURIComponent(entrypoint)}/invoke`;
  const response = await lucidFetch(
    url,
    { method: "POST", headers, body: JSON.stringify({ input: body }) },
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
    if (paymentHeader) {
      return failure(
        `Entrypoint ${entrypoint} rejected the payment: HTTP 402 ${text.slice(0, 300)}`,
        ExecutionErrorType.USER,
        402
      );
    }
    return {
      success: true,
      status: "awaiting_payment",
      httpStatus: 402,
      payment: readPaymentTerms(challenge),
      paymentRequired: challenge ?? text,
    };
  }

  if (!response.ok) {
    return httpFailure(`Entrypoint ${entrypoint} failed`, response, text);
  }

  const output =
    typeof parsed === "object" && parsed !== null && "output" in parsed
      ? (parsed as { output: unknown }).output
      : (parsed ?? text);

  return {
    success: true,
    status: "completed",
    httpStatus: response.status,
    output,
    paid: Boolean(paymentHeader),
    paymentResponse: readHeaderJson(response.headers, SETTLEMENT_HEADERS),
  };
}

/**
 * Call Lucid Entrypoint Step
 * Invokes one entrypoint. A priced entrypoint called without a payment header
 * returns its x402 terms as data; this step never signs or pays.
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

// An automatic retry would call the agent again, and with a payment header
// attached would re-present the same signed payment.
callEntrypointStep.maxRetries = 0;

export const _integrationType = "lucid";
