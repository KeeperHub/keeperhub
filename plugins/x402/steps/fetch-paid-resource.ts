import "server-only";

import { ErrorCategory, logUserError } from "@/lib/logging";
import {
  assertUrlIsPublic,
  safeFetch,
  SsrfBlockedError,
} from "@/lib/safe-fetch";
import { getErrorMessage } from "@/lib/utils";
import {
  runPluginStep,
  type StepInput,
} from "@/lib/workflow/executor/step-handler";

const DIGITS_RE = /^\d+$/;
const USDC_AMOUNT_RE = /^\d+(\.\d{1,6})?$/;

// x402 "exact"-scheme quotes denominate USD stablecoins with 6 decimals
// (USDC on every x402 rail). The spend-cap comparison stays in integer
// atomic units so no float ever touches money.
const USDC_ATOMIC_DECIMALS = 6;

// Chains users commonly name instead of using CAIP-2 ("eip155:8453") form.
const NETWORK_ALIASES: Record<string, string> = {
  arbitrum: "eip155:42161",
  base: "eip155:8453",
  ethereum: "eip155:1",
  mainnet: "eip155:1",
  optimism: "eip155:10",
  polygon: "eip155:137",
};

const PAYMENT_REQUIRED_HEADER = "payment-required";

// A hung resource server must not hold the workflow step open: both the
// initial probe and the paid retry carry an explicit timeout, mirroring
// plugins/evm-chain/steps/evm-rpc-core.ts (safeFetch applies no default).
const FETCH_TIMEOUT_MS = 10_000;

// A single entry of an x402 v1/v2 402 body's `accepts[]` array. All fields
// are unknown at the boundary; toPaymentQuote validates the load-bearing ones.
type X402AcceptRequirement = {
  scheme?: unknown;
  network?: unknown;
  amount?: unknown;
  maxAmountRequired?: unknown;
  asset?: unknown;
  payTo?: unknown;
  resource?: unknown;
  maxTimeoutSeconds?: unknown;
};

// Validated payment terms handed to the workflow so a downstream wallet step
// (agentic-wallet sign entrypoint, Code step) can produce the X-PAYMENT value.
export type X402PaymentQuote = {
  scheme: string;
  network: string;
  asset: string;
  payTo: string;
  amountAtomic: string;
  priceUsdc: string;
};

type FetchPaidResourceResult =
  | {
      success: true;
      paid: boolean;
      statusCode: number;
      data: unknown;
      priceUsdc: string | null;
    }
  | {
      success: false;
      error: string;
      paymentRequired?: boolean;
      paymentQuote?: X402PaymentQuote | null;
      priceUsdc?: string | null;
    };

export type FetchPaidResourceCoreInput = {
  resourceUrl: string;
  httpMethod?: string;
  network?: string;
  maxPriceUsdc?: string | number;
  paymentSignature?: string;
  headers?: string;
  requestBody?: string;
};

export type FetchPaidResourceInput = StepInput & FetchPaidResourceCoreInput;

function logFields(actionName: string): {
  plugin_name: string;
  action_name: string;
} {
  return { plugin_name: "x402", action_name: actionName };
}

function normalizeNetwork(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (DIGITS_RE.test(trimmed)) {
    return `eip155:${trimmed}`;
  }
  return NETWORK_ALIASES[trimmed] ?? trimmed;
}

function toAtomicBigInt(value: unknown): bigint | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? BigInt(value) : null;
  }
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!DIGITS_RE.test(trimmed)) {
    return null;
  }
  try {
    const parsed = BigInt(trimmed);
    return parsed > BigInt(0) ? parsed : null;
  } catch {
    return null;
  }
}

// Strict dollars-to-atomic parse for the spend cap ("0.05" -> 50000n).
// Rejects negatives, empty strings, and >6 fraction digits.
function usdcToAtomic(value: string): bigint | null {
  const trimmed = value.trim();
  if (!USDC_AMOUNT_RE.test(trimmed)) {
    return null;
  }
  const [whole, fraction = ""] = trimmed.split(".");
  const padded = (fraction + "000000").slice(0, USDC_ATOMIC_DECIMALS);
  try {
    return BigInt(`${whole}${padded}`);
  } catch {
    return null;
  }
}

function atomicToUsdc(amount: bigint): string {
  const divisor = BigInt(10) ** BigInt(USDC_ATOMIC_DECIMALS);
  const whole = amount / divisor;
  const fraction = (amount % divisor).toString().padStart(USDC_ATOMIC_DECIMALS, "0");
  const trimmedFraction = fraction.replace(/0+$/, "");
  return trimmedFraction === "" ? whole.toString() : `${whole}.${trimmedFraction}`;
}

async function readBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type");
  if (contentType?.includes("application/json")) {
    try {
      return await response.json();
    } catch {
      return await response.text();
    }
  }
  return await response.text();
}

function acceptsFromBody(body: unknown): X402AcceptRequirement[] | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }
  const accepts = (body as { accepts?: unknown }).accepts;
  return Array.isArray(accepts) ? (accepts as X402AcceptRequirement[]) : null;
}

function acceptsFromHeader(headerValue: string | null): X402AcceptRequirement[] | null {
  if (!headerValue) {
    return null;
  }
  try {
    const decoded = JSON.parse(
      Buffer.from(headerValue, "base64").toString("utf-8")
    ) as unknown;
    return acceptsFromBody(decoded);
  } catch {
    return null;
  }
}

function selectRequirement(
  requirements: X402AcceptRequirement[],
  networkFilter: string | undefined
): X402AcceptRequirement | null {
  if (requirements.length === 0) {
    return null;
  }
  if (!networkFilter || networkFilter.trim() === "") {
    return requirements[0] ?? null;
  }
  const wanted = normalizeNetwork(networkFilter);
  for (const requirement of requirements) {
    if (
      typeof requirement.network === "string" &&
      normalizeNetwork(requirement.network) === wanted
    ) {
      return requirement;
    }
  }
  return null;
}

function toPaymentQuote(
  requirement: X402AcceptRequirement
): X402PaymentQuote | null {
  const atomic = toAtomicBigInt(
    requirement.maxAmountRequired ?? requirement.amount
  );
  if (atomic === null) {
    return null;
  }
  if (
    typeof requirement.payTo !== "string" ||
    requirement.payTo.trim() === "" ||
    typeof requirement.network !== "string" ||
    requirement.network.trim() === "" ||
    typeof requirement.asset !== "string" ||
    requirement.asset.trim() === ""
  ) {
    return null;
  }
  return {
    scheme:
      typeof requirement.scheme === "string" && requirement.scheme !== ""
        ? requirement.scheme
        : "exact",
    network: requirement.network,
    asset: requirement.asset,
    payTo: requirement.payTo,
    amountAtomic: atomic.toString(),
    priceUsdc: atomicToUsdc(atomic),
  };
}

function parseJsonField(
  raw: string | undefined,
  fieldName: string
): { ok: true; value: Record<string, string> } | { ok: false; error: string } {
  if (!raw || raw.trim() === "") {
    return { ok: true, value: {} };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: `${fieldName} must be a JSON object` };
    }
    const value: Record<string, string> = {};
    for (const [key, entry] of Object.entries(parsed)) {
      if (typeof entry === "string") {
        value[key] = entry;
      }
    }
    return { ok: true, value };
  } catch {
    return { ok: false, error: `${fieldName} must be valid JSON` };
  }
}

function paymentRequiredFailure(
  quote: X402PaymentQuote,
  reason: string
): FetchPaidResourceResult {
  return {
    success: false,
    error: reason,
    paymentRequired: true,
    paymentQuote: quote,
    priceUsdc: quote.priceUsdc,
  };
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: x402 handshake (quote, cap, retry) needs sequential validation
async function stepHandler(
  input: FetchPaidResourceCoreInput
): Promise<FetchPaidResourceResult> {
  const url = input.resourceUrl;
  const method = input.httpMethod || "GET";

  if (!url) {
    logUserError(ErrorCategory.CONFIGURATION, "[x402] No URL provided", undefined, logFields("fetch-paid-resource"));
    return { success: false, error: "Resource URL is required" };
  }

  try {
    new URL(url);
  } catch {
    logUserError(ErrorCategory.VALIDATION, "[x402] Invalid URL format", url, logFields("fetch-paid-resource"));
    return { success: false, error: "Invalid resource URL format" };
  }

  const headersParsed = parseJsonField(input.headers, "headers");
  if (!headersParsed.ok) {
    return { success: false, error: headersParsed.error };
  }
  const headers: Record<string, string> = headersParsed.value;

  let payload: unknown = null;
  if (input.requestBody && input.requestBody.trim() !== "") {
    try {
      payload = JSON.parse(input.requestBody);
    } catch {
      return { success: false, error: "requestBody must be valid JSON" };
    }
  }
  if (
    !(headers["Content-Type"] || headers["content-type"]) &&
    method !== "GET" &&
    payload !== null
  ) {
    headers["Content-Type"] = "application/json";
  }

  // SSRF guard: always-on, ignores shadow mode, so a user-controlled
  // resourceUrl pointing at an internal address is blocked before any
  // outbound request (same posture as the webhook action).
  try {
    await assertUrlIsPublic(url);
  } catch (error) {
    if (error instanceof SsrfBlockedError) {
      logUserError(ErrorCategory.VALIDATION, "[x402] Blocked SSRF target", error.message, logFields("fetch-paid-resource"));
      return {
        success: false,
        error: `Resource URL is not allowed: ${error.message}`,
      };
    }
    logUserError(ErrorCategory.VALIDATION, "[x402] Could not validate resource URL", error, logFields("fetch-paid-resource"));
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Resource URL is invalid or could not be resolved",
    };
  }

  let response: Response;
  try {
    response = await safeFetch(url, {
      method,
      headers,
      ...(method !== "GET" && payload !== null
        ? { body: JSON.stringify(payload) }
        : {}),
      plugin: "x402",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    logUserError(ErrorCategory.EXTERNAL_SERVICE, "[x402] Error fetching resource:", error, logFields("fetch-paid-resource"));
    return {
      success: false,
      error: `Failed to fetch resource: ${getErrorMessage(error)}`,
    };
  }

  const body = await readBody(response);

  if (response.status !== 402) {
    if (!response.ok) {
      logUserError(
        ErrorCategory.EXTERNAL_SERVICE,
        "[x402] API error:",
        { status: response.status, body },
        logFields("fetch-paid-resource")
      );
      return {
        success: false,
        error: `HTTP ${response.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`,
      };
    }
    return {
      success: true,
      paid: false,
      statusCode: response.status,
      data: body,
      priceUsdc: null,
    };
  }

  const requirements =
    acceptsFromBody(body) ??
    acceptsFromHeader(response.headers.get(PAYMENT_REQUIRED_HEADER));
  if (!requirements || requirements.length === 0) {
    return {
      success: false,
      error:
        "Endpoint returned 402 without x402 payment requirements (no accepts[] in body or PAYMENT-REQUIRED header)",
    };
  }

  const selected = selectRequirement(requirements, input.network);
  if (!selected) {
    const available = requirements
      .map((requirement) =>
        typeof requirement.network === "string" ? requirement.network : "unknown"
      )
      .join(", ");
    return {
      success: false,
      error: `No x402 requirement matches network "${input.network}". Available: ${available}`,
    };
  }

  const quote = toPaymentQuote(selected);
  if (!quote) {
    return {
      success: false,
      error:
        "x402 requirement has an unsupported shape (need payTo, asset, network, and a positive amount/maxAmountRequired)",
    };
  }

  // Spend cap: never auto-pay above maxPriceUsdc. Comparison is integer
  // atomic-vs-atomic; the cap defaults to $0.05 when unset.
  const capRaw =
    typeof input.maxPriceUsdc === "number"
      ? String(input.maxPriceUsdc)
      : (input.maxPriceUsdc ?? "0.05");
  const capAtomic = usdcToAtomic(capRaw);
  if (capAtomic === null) {
    return {
      success: false,
      error: `maxPriceUsdc must be a non-negative dollar amount with up to 6 decimals (got "${capRaw}")`,
    };
  }
  const quoteAtomic = BigInt(quote.amountAtomic);
  if (quoteAtomic > capAtomic) {
    logUserError(
      ErrorCategory.VALIDATION,
      "[x402] Quote exceeds spend cap",
      { priceUsdc: quote.priceUsdc, cap: capRaw },
      logFields("fetch-paid-resource")
    );
    return paymentRequiredFailure(
      quote,
      `Quoted price $${quote.priceUsdc} exceeds maxPriceUsdc $${atomicToUsdc(capAtomic)}. Raise the cap or handle paymentQuote manually.`
    );
  }

  // No signature yet: hand the validated quote back so the workflow can sign
  // it at the wallet boundary (agentic-wallet sign entrypoint) and retry via
  // paymentSignature. This node never holds keys.
  const signature = input.paymentSignature?.trim() || "";
  if (signature === "") {
    return paymentRequiredFailure(
      quote,
      `Payment required: $${quote.priceUsdc} USDC to ${quote.payTo} on ${quote.network}. Sign paymentQuote with the org wallet and retry with paymentSignature.`
    );
  }

  let paidResponse: Response;
  try {
    // X-PAYMENT is the v1/facilitator header name; PAYMENT-SIGNATURE is read
    // by v2-style servers. Send both with the same value for compatibility.
    paidResponse = await safeFetch(url, {
      method,
      headers: {
        ...headers,
        "X-PAYMENT": signature,
        "PAYMENT-SIGNATURE": signature,
      },
      ...(method !== "GET" && payload !== null
        ? { body: JSON.stringify(payload) }
        : {}),
      plugin: "x402",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    logUserError(ErrorCategory.EXTERNAL_SERVICE, "[x402] Error fetching paid resource:", error, logFields("fetch-paid-resource"));
    return {
      success: false,
      error: `Failed to fetch paid resource: ${getErrorMessage(error)}`,
    };
  }

  const paidBody = await readBody(paidResponse);
  if (paidResponse.status === 402) {
    return paymentRequiredFailure(
      quote,
      `Payment was rejected by the endpoint: ${typeof paidBody === "string" ? paidBody : JSON.stringify(paidBody)}`
    );
  }
  if (!paidResponse.ok) {
    return {
      success: false,
      error: `HTTP ${paidResponse.status}: ${typeof paidBody === "string" ? paidBody : JSON.stringify(paidBody)}`,
    };
  }
  return {
    success: true,
    paid: true,
    statusCode: paidResponse.status,
    data: paidBody,
    priceUsdc: quote.priceUsdc,
  };
}

/**
 * App entry point - wraps with logging
 */
// biome-ignore lint/suspicious/useAwait: "use step" directive requires async
export async function fetchPaidResourceStep(
  input: FetchPaidResourceInput
): Promise<FetchPaidResourceResult> {
  "use step";

  return runPluginStep(
    { pluginName: "x402", actionName: "fetch-paid-resource" },
    input,
    stepHandler
  );
}
// A workflow-level retry would re-send a signed payment and could double-pay.
// Surface the quote/payment state instead and let the workflow decide.
fetchPaidResourceStep.maxRetries = 0;

export const _integrationType = "x402";
