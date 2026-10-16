/**
 * Core Paid Request (x402) logic shared between the web3 paid-request step
 * and any future direct-execution / MCP wrappers.
 *
 * IMPORTANT: This file must NOT contain "use step" or be a step file.
 *
 * Calls an HTTP endpoint; when the endpoint answers 402 with an x402 v2
 * payment challenge, pays the quoted USDC on Base from the org's Turnkey
 * wallet (EIP-3009 TransferWithAuthorization) and retries the request with
 * the payment. Free responses pass through without signing anything.
 *
 * This step is the sanctioned exception to the sign-typed-data fund-moving
 * denylist (see plugins/web3/steps/sign-typed-data-core.ts): it never signs
 * a caller- or seller-supplied payload. The authorization is built in
 * lib/payments/x402/buyer.ts from the CHECKED quote (scheme, network,
 * asset, amount, payee, validity all validated; the seller's `extra` and
 * `asset` are never copied into the signature), the amount is bounded by
 * the step's max price and a 100 USDC ceiling, and the step refuses to run
 * in marketplace-listed workflows so a template cannot smuggle a drain
 * past the author.
 */
import "server-only";

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { workflows } from "@/lib/db/schema";
import {
  PolicyBlockedError,
  signTypedDataWithTurnkey,
  TurnkeyUpstreamError,
} from "@/lib/agentic-wallet/sign-typed-data";
import { toChecksumAddress } from "@/lib/address-utils";
import { isFeatureEnabledForOrg } from "@/lib/features/server";
import {
  buildAuthorizationTypedData,
  checkQuote,
  decodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
  formatUsdc,
} from "@/lib/payments/x402/buyer";
import {
  assertUrlIsPublic,
  safeFetch,
  SsrfBlockedError,
} from "@/lib/safe-fetch";
import { getOrganizationWallet } from "@/lib/web3/wallet-helpers";
import { resolveOrganizationContext } from "@/lib/web3/resolve-org-context";
import { MAX_STORED_OUTPUT_BYTES } from "@/lib/workflow/output-limits";
import { getErrorMessage } from "@/lib/utils";

export type PaidRequestCoreInput = {
  /** The endpoint to call. SSRF-guarded; redirects are refused. */
  url: string;
  /** HTTP method. Defaults to POST. */
  method?: string;
  /** Request headers as a JSON object string. */
  headers?: string;
  /** Request body as a raw string (sent verbatim). */
  body?: string;
  /**
   * Required. The maximum USDC the step will pay for one request, as a
   * human amount (e.g. "0.25"). A quote at or above this is refused; a
   * 100 USDC per-payment ceiling applies regardless.
   */
  maxPriceUsdc: string;
  /**
   * Optional. When set, only a quote whose payTo matches this address
   * (case-insensitive) is paid.
   */
  expectedPayTo?: string;
  /** Per-request timeout in seconds. Defaults to 10, clamped to 1-30. */
  timeout?: number;
  _context?: {
    executionId?: string;
    organizationId?: string;
    userId?: string;
    workflowId?: string;
  };
};

export type PaidRequestResult =
  | {
      success: true;
      /** Whether a 402 was answered with a payment. */
      paid: boolean;
      status: number;
      data: unknown;
      /** USDC amount paid, set when paid is true. */
      amountUsdc?: string;
      /** Payee address, set when paid is true. */
      payTo?: string;
    }
  | {
      success: false;
      error: string;
      code:
        | "VALIDATION"
        | "FEATURE_DISABLED"
        | "LISTED_WORKFLOW"
        | "NO_WALLET"
        | "POLICY_BLOCKED"
        | "UPSTREAM"
        | "HTTP"
        | "UNKNOWN";
      status?: number;
    };

const DEFAULT_TIMEOUT_SECONDS = 10;
const MIN_TIMEOUT_SECONDS = 1;
const MAX_TIMEOUT_SECONDS = 30;

const VALID_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);

function resolveTimeoutMs(timeout: unknown): number {
  if (timeout === undefined || timeout === null || timeout === "") {
    return DEFAULT_TIMEOUT_SECONDS * 1000;
  }
  const requested = typeof timeout === "number" ? timeout : Number(timeout);
  const seconds = Number.isFinite(requested)
    ? Math.min(Math.max(MIN_TIMEOUT_SECONDS, requested), MAX_TIMEOUT_SECONDS)
    : DEFAULT_TIMEOUT_SECONDS;
  return seconds * 1000;
}

function resolveMethod(method: unknown): string {
  if (typeof method === "string" && VALID_METHODS.has(method.trim().toUpperCase())) {
    return method.trim().toUpperCase();
  }
  return "POST";
}

function parseHeaders(headers: unknown): Record<string, string> {
  if (!headers || typeof headers !== "string" || headers.trim() === "") {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(headers);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed)) {
        out[key] = String(value);
      }
      return out;
    }
  } catch {
    // Fall through to the validation error below.
  }
  throw new Error("headers must be a JSON object string");
}

/** Read a response body as text, bounded so one upstream response cannot
 * take the executor's memory. Mirrors the limit in lib/workflow/output-limits. */
async function readBoundedText(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_STORED_OUTPUT_BYTES) {
    throw new Error(
      `response body of ${declared} bytes exceeds the step output limit`
    );
  }
  const text = await response.text();
  if (text.length > MAX_STORED_OUTPUT_BYTES) {
    throw new Error("response body exceeds the step output limit");
  }
  return text;
}

function parseJsonBody(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === "") {
    return null;
  }
  return JSON.parse(trimmed);
}

/**
 * Refuse to run inside a marketplace-listed workflow. A listed template is
 * author-controlled by someone other than the wallet owner, so letting it
 * sign payments would let a template drain the org wallet through the
 * paid-request exception. Direct executions (no workflow) are the org's own
 * call and are allowed.
 */
async function assertNotListedWorkflow(
  workflowId: string | undefined
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!workflowId) {
    return { ok: true };
  }
  const rows = await db
    .select({ isListed: workflows.isListed })
    .from(workflows)
    .where(eq(workflows.id, workflowId))
    .limit(1);
  const workflow = rows[0];
  if (workflow?.isListed) {
    return {
      ok: false,
      error:
        "Paid Request is refused in marketplace-listed workflows: a listed template must not move the org wallet's funds",
    };
  }
  return { ok: true };
}

type FetchArgs = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
  timeoutMs: number;
  paymentHeader?: string;
};

/** Every request: SSRF pre-check, manual redirects, timeout. */
async function doFetch(args: FetchArgs): Promise<Response> {
  await assertUrlIsPublic(args.url);
  const headers = { ...args.headers };
  if (args.paymentHeader) {
    headers["PAYMENT-SIGNATURE"] = args.paymentHeader;
  }
  return safeFetch(args.url, {
    method: args.method,
    headers,
    body: args.body,
    redirect: "manual",
    signal: AbortSignal.timeout(args.timeoutMs),
    plugin: "web3",
  });
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

export async function paidRequestCore(
  input: PaidRequestCoreInput
): Promise<PaidRequestResult> {
  const url = input.url?.trim();
  if (!url) {
    return { success: false, error: "url is required", code: "VALIDATION" };
  }

  const ctx = await resolveOrganizationContext(
    {
      executionId: input._context?.executionId,
      organizationId: input._context?.organizationId,
    },
    "[paid-request]",
    "paid-request"
  );
  if (!ctx.success) {
    return { success: false, error: ctx.error, code: "NO_WALLET" };
  }
  const { organizationId } = ctx;

  // The direct node route (/api/execute/node) does not consult feature
  // gates, so the switch is re-checked here, inside the step.
  const featureEnabled = await isFeatureEnabledForOrg(
    "action.paid-request",
    organizationId
  );
  if (!featureEnabled) {
    return {
      success: false,
      error: "Paid Request (x402) is not enabled for this organization",
      code: "FEATURE_DISABLED",
    };
  }

  const listed = await assertNotListedWorkflow(input._context?.workflowId);
  if (!listed.ok) {
    return { success: false, error: listed.error, code: "LISTED_WORKFLOW" };
  }

  let headers: Record<string, string>;
  try {
    headers = parseHeaders(input.headers);
  } catch (err) {
    return {
      success: false,
      error: getErrorMessage(err),
      code: "VALIDATION",
    };
  }
  const method = resolveMethod(input.method);
  const body = input.body && method !== "GET" && method !== "HEAD" ? input.body : undefined;
  const timeoutMs = resolveTimeoutMs(input.timeout);

  let first: Response;
  try {
    first = await doFetch({ url, method, headers, body, timeoutMs });
  } catch (err) {
    if (err instanceof SsrfBlockedError) {
      return { success: false, error: err.message, code: "VALIDATION" };
    }
    return { success: false, error: getErrorMessage(err), code: "HTTP" };
  }

  if (isRedirect(first.status)) {
    return {
      success: false,
      error: `Paid Request refused redirect (status ${first.status}): redirects are never followed`,
      code: "VALIDATION",
      status: first.status,
    };
  }

  // Free responses pass through without signing anything.
  if (first.status !== 402) {
    let data: unknown;
    try {
      data = parseJsonBody(await readBoundedText(first));
    } catch (err) {
      return { success: false, error: getErrorMessage(err), code: "HTTP" };
    }
    if (!first.ok) {
      return {
        success: false,
        error: `Request failed with status ${first.status}`,
        code: "HTTP",
        status: first.status,
      };
    }
    return { success: true, paid: false, status: first.status, data };
  }

  // 402: read the x402 v2 challenge and check it against the step's bounds
  // BEFORE anything is signed. The challenge arrives canonically in the
  // PAYMENT-REQUIRED response header (base64 JSON); some servers put it in
  // the JSON body instead, so the body is the fallback. checkQuote refuses
  // v1 challenges, non-exact schemes, non-Base networks, non-USDC assets,
  // overpriced quotes, payee mismatches, and missing validity windows.
  let challenge: unknown = decodePaymentRequiredHeader(
    first.headers.get("PAYMENT-REQUIRED")
  );
  let challengeSource = "PAYMENT-REQUIRED header";
  if (challenge === null) {
    try {
      challenge = parseJsonBody(await readBoundedText(first));
      challengeSource = "response body";
    } catch (err) {
      return {
        success: false,
        error: `402 challenge is not usable (no PAYMENT-REQUIRED header and body is not JSON): ${getErrorMessage(err)}`,
        code: "VALIDATION",
        status: 402,
      };
    }
  }
  const checked = checkQuote(challenge, {
    maxPriceUsdc: input.maxPriceUsdc ?? "",
    expectedPayTo: input.expectedPayTo,
  });
  if (!checked.ok) {
    return {
      success: false,
      error: `402 challenge from ${challengeSource} rejected: ${checked.error}`,
      code: "VALIDATION",
      status: 402,
    };
  }
  const { quote } = checked;

  let wallet: { walletAddress: string; turnkeySubOrgId: string | null };
  try {
    wallet = await getOrganizationWallet(organizationId);
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Failed to load organization wallet",
      code: "NO_WALLET",
    };
  }
  if (!wallet.turnkeySubOrgId) {
    return {
      success: false,
      error: "Organization wallet is not Turnkey-backed; x402 payment requires a Turnkey wallet",
      code: "NO_WALLET",
    };
  }

  // Build the EIP-3009 authorization from the CHECKED quote. The seller's
  // `extra` and `asset` never enter the signed payload: the domain and
  // verifying contract come from the rail.
  const from = toChecksumAddress(wallet.walletAddress);
  const { typedData, authorization } = buildAuthorizationTypedData(quote, from);

  let signature: string;
  try {
    signature = await signTypedDataWithTurnkey(
      wallet.turnkeySubOrgId,
      from,
      typedData
    );
  } catch (err) {
    if (err instanceof PolicyBlockedError) {
      return { success: false, error: err.message, code: "POLICY_BLOCKED" };
    }
    if (err instanceof TurnkeyUpstreamError) {
      return { success: false, error: err.message, code: "UPSTREAM" };
    }
    return { success: false, error: getErrorMessage(err), code: "UNKNOWN" };
  }

  const paymentHeader = encodePaymentSignatureHeader(signature, authorization);

  let second: Response;
  try {
    second = await doFetch({
      url,
      method,
      headers,
      body,
      timeoutMs,
      paymentHeader,
    });
  } catch (err) {
    if (err instanceof SsrfBlockedError) {
      return { success: false, error: err.message, code: "VALIDATION" };
    }
    return { success: false, error: getErrorMessage(err), code: "HTTP" };
  }

  if (isRedirect(second.status)) {
    return {
      success: false,
      error: `Paid Request refused redirect (status ${second.status}): redirects are never followed`,
      code: "VALIDATION",
      status: second.status,
    };
  }

  let data: unknown;
  try {
    data = parseJsonBody(await readBoundedText(second));
  } catch (err) {
    return { success: false, error: getErrorMessage(err), code: "HTTP" };
  }
  if (!second.ok) {
    return {
      success: false,
      error: `Paid request failed with status ${second.status}`,
      code: "HTTP",
      status: second.status,
    };
  }

  const amountUsdc = formatUsdc(quote.amountRaw);
  return {
    success: true,
    paid: true,
    status: second.status,
    data,
    amountUsdc,
    payTo: quote.payTo,
  };
}
