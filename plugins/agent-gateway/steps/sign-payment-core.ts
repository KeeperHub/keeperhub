/**
 * Core sign-payment-challenge logic, kept out of the step file so the shared
 * HMAC signer can be imported by both agent-gateway steps.
 *
 * IMPORTANT: This file must NOT contain "use step" or be a step file.
 *
 * Proxies POST /api/agentic-wallet/sign - see that route for the full
 * request/response contract. The server resolves the sub-org from the
 * HMAC-verified headers (never from the body), classifies the operation's
 * risk, and either signs immediately (200), queues a human approval (202),
 * or blocks (403). This step surfaces all three outcomes as distinct,
 * non-error results rather than throwing, since a 202 "pending approval" is
 * an expected outcome, not a failure.
 */
import "server-only";

import type { AgentGatewayCredentials } from "../credentials";
import {
  hmacSignedRequest,
  MISSING_CREDENTIALS_ERROR,
  toHmacCredentials,
} from "./hmac-request-core";

export type SignPaymentCoreInput = {
  chain: "base" | "tempo";
  workflowSlug?: string;
  paymentChallenge: unknown;
};

export type SignPaymentResult =
  | { success: true; status: "signed"; signature: string }
  | { success: true; status: "pending_approval"; approvalRequestId: string }
  | { success: false; status: "blocked" | "error"; error: string; code?: string };

type ParsedChallenge =
  | { challenge: Record<string, unknown> }
  | { error: string };

/**
 * The `json-editor` UI field (Monaco-backed) emits its value as a JSON
 * string, while direct/MCP callers pass a native object. Parse the string
 * shape here so the request always carries the object that
 * /api/agentic-wallet/sign requires - it answers a non-object challenge with
 * `400 paymentChallenge required`. Mirrors `signTypedDataCore` in
 * plugins/web3/steps/sign-typed-data-core.ts.
 */
function parsePaymentChallenge(raw: unknown): ParsedChallenge {
  let value = raw;

  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { error: `paymentChallenge is not valid JSON: ${detail}` };
    }
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: "paymentChallenge must be a JSON object" };
  }

  return { challenge: value as Record<string, unknown> };
}

export async function signPaymentCore(
  input: SignPaymentCoreInput,
  credentials: AgentGatewayCredentials
): Promise<SignPaymentResult> {
  const hmac = toHmacCredentials(credentials);
  if (!hmac) {
    return {
      success: false,
      status: "error",
      error: MISSING_CREDENTIALS_ERROR,
    };
  }

  // The endpoint derives the payee and the amount from the workflows registry
  // by slug and rejects a request without one, so a blank slug is a
  // guaranteed 400. Fail here rather than spend the round trip.
  if (!input.workflowSlug) {
    return {
      success: false,
      status: "error",
      error:
        "workflowSlug is required: /api/agentic-wallet/sign derives the payee and amount from the workflows registry by slug.",
      code: "WORKFLOW_SLUG_REQUIRED",
    };
  }

  const parsed = parsePaymentChallenge(input.paymentChallenge);
  if ("error" in parsed) {
    return { success: false, status: "error", error: parsed.error };
  }

  let response: Response;
  try {
    response = await hmacSignedRequest(
      hmac,
      "POST",
      "/api/agentic-wallet/sign",
      {
        chain: input.chain,
        workflowSlug: input.workflowSlug,
        paymentChallenge: parsed.challenge,
      }
    );
  } catch (error) {
    return {
      success: false,
      status: "error",
      error: error instanceof Error ? error.message : "Request failed",
    };
  }

  const data = ((await response.json().catch(() => null)) ?? {}) as Record<
    string,
    unknown
  >;

  if (response.status === 200 && typeof data.signature === "string") {
    return { success: true, status: "signed", signature: data.signature };
  }

  if (response.status === 202 && typeof data.approvalRequestId === "string") {
    return {
      success: true,
      status: "pending_approval",
      approvalRequestId: data.approvalRequestId,
    };
  }

  return {
    success: false,
    status: response.status === 403 ? "blocked" : "error",
    error:
      typeof data.error === "string"
        ? data.error
        : `Request failed with status ${response.status}`,
    code: typeof data.code === "string" ? data.code : undefined,
  };
}
