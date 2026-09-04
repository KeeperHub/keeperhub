/**
 * Core check-credit-balance logic, kept out of the step file so the shared
 * HMAC signer can be imported by both agent-gateway steps.
 *
 * IMPORTANT: This file must NOT contain "use step" or be a step file.
 *
 * Reads the sub-org's off-chain KeeperHub credit ledger via
 * GET /api/agentic-wallet/credit (see that route for the response contract).
 */
import "server-only";

import type { AgentGatewayCredentials } from "../credentials";
import {
  hmacSignedRequest,
  MISSING_CREDENTIALS_ERROR,
  toHmacCredentials,
} from "./hmac-request-core";

export type CheckCreditResult =
  | { success: true; amount: string; currency: string; subOrgId: string }
  | { success: false; error: string; code?: string };

/**
 * The action has no config fields - the sub-org being read is the one the
 * selected connection's credentials authenticate as, never a node parameter.
 */
export async function checkCreditCore(
  credentials: AgentGatewayCredentials
): Promise<CheckCreditResult> {
  const hmac = toHmacCredentials(credentials);
  if (!hmac) {
    return { success: false, error: MISSING_CREDENTIALS_ERROR };
  }

  let response: Response;
  try {
    response = await hmacSignedRequest(
      hmac,
      "GET",
      "/api/agentic-wallet/credit"
    );
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Request failed",
    };
  }

  const data = ((await response.json().catch(() => null)) ?? {}) as Record<
    string,
    unknown
  >;

  if (!response.ok) {
    return {
      success: false,
      error:
        typeof data.error === "string"
          ? data.error
          : `Request failed with status ${response.status}`,
      code: typeof data.code === "string" ? data.code : undefined,
    };
  }

  // A 200 that does not carry the documented balance envelope is an error,
  // not a zero balance. An environment behind an access proxy answers 200
  // with an HTML interstitial, and reporting success there would hand a
  // downstream Condition a balance that was never read.
  const { amount, currency, subOrgId } = data;
  if (
    !(typeof amount === "string" || typeof amount === "number") ||
    typeof currency !== "string" ||
    typeof subOrgId !== "string"
  ) {
    return {
      success: false,
      error:
        "Unexpected response from /api/agentic-wallet/credit: the body did not carry amount, currency and subOrgId.",
    };
  }

  return { success: true, amount: String(amount), currency, subOrgId };
}
