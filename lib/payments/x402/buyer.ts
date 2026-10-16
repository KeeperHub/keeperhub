/**
 * Buyer-side x402 v2 payment builder for the web3/paid-request workflow step.
 *
 * The step calls an HTTP endpoint; when the endpoint answers 402 with an x402
 * v2 payment challenge, the helpers here validate the quoted requirement and
 * build the EIP-3009 `TransferWithAuthorization` typed-data from the CHECKED
 * quote. A supplied payload is never signed: the seller's `extra` is ignored
 * (the domain comes from the rail) and the seller's `asset` is verified
 * against the rail but never copied into the signature.
 *
 * Pure functions only (no Turnkey, no DB) so the quote-validation and bounds
 * logic is unit-testable. Signing happens in the step core via
 * `signTypedDataWithTurnkey`.
 */
import "server-only";

import { randomBytes } from "node:crypto";
import {
  AUTHORIZATION_TYPES,
  BASE_USDC_DOMAIN,
} from "@/lib/agentic-wallet/sign";
import type { EIP712TypedData } from "@/lib/agentic-wallet/sign-typed-data";
import { BASE_RAIL } from "@/lib/payments/rails";

/** Hard ceiling per payment: 100 USDC at 6 decimals. */
export const MAX_PAYMENT_USDC_RAW = BigInt(100_000_000);

/** Seller validity is capped at 10 minutes regardless of the quote. */
export const MAX_VALIDITY_SECONDS = 600;

const HEX_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const RAW_AMOUNT_RE = /^[0-9]+$/;
const USDC_AMOUNT_RE = /^\d+(\.\d{1,6})?$/;
const TRAILING_ZEROS_RE = /0+$/;

/** A 402 requirement that survived every check in `checkQuote`. */
export type CheckedQuote = {
  /** Quoted amount in USDC raw units (6 decimals). */
  amountRaw: bigint;
  /** Seller's payee address, validated as a 0x address. */
  payTo: string;
  /** Payment validity window in seconds: seller's maxTimeoutSeconds capped. */
  validitySeconds: number;
};

export type QuoteCheckFailure = {
  ok: false;
  /** Short machine-readable reason, safe to surface to the workflow author. */
  code:
    | "NOT_X402_V2"
    | "NO_ACCEPTABLE_REQUIREMENT"
    | "INVALID_MAX_PRICE"
    | "AMOUNT_EXCEEDS_MAX_PRICE"
    | "AMOUNT_EXCEEDS_CEILING"
    | "PAYEE_MISMATCH";
  error: string;
};

export type QuoteCheckResult =
  | { ok: true; quote: CheckedQuote }
  | QuoteCheckFailure;

export type QuoteCheckOptions = {
  /**
   * The step's required max price in human USDC (e.g. "0.25"). A quote at or
   * above this is refused. Must parse to a positive 6-decimal amount.
   */
  maxPriceUsdc: string;
  /** Optional expected payee. When set, any other payTo is refused. */
  expectedPayTo?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHexAddress(value: unknown): value is string {
  return typeof value === "string" && HEX_ADDRESS_RE.test(value);
}

/**
 * Parse a human USDC amount ("0.25", "100") into raw units (6 decimals).
 * Returns null for anything that is not a finite, positive decimal with at
 * most 6 fractional digits. Strict: no exponents, no whitespace, no signs.
 */
export function parseUsdcToRaw(value: string): bigint | null {
  if (!USDC_AMOUNT_RE.test(value)) {
    return null;
  }
  const [whole = "0", frac = ""] = value.split(".");
  const raw = BigInt(whole) * BigInt(1_000_000) + BigInt(frac.padEnd(6, "0"));
  return raw > BigInt(0) ? raw : null;
}

/** Format raw USDC units (6 decimals) as a human amount, e.g. "0.25". Exported
 * for step outputs. */
export function formatUsdc(raw: bigint): string {
  const whole = raw / BigInt(1_000_000);
  const frac = (raw % BigInt(1_000_000))
    .toString()
    .padStart(6, "0")
    .replace(TRAILING_ZEROS_RE, "");
  return frac === "" ? whole.toString() : `${whole}.${frac}`;
}

type RawRequirement = {
  scheme: unknown;
  network: unknown;
  amount: unknown;
  asset: unknown;
  payTo: unknown;
  maxTimeoutSeconds: unknown;
};

/**
 * Check one 402 `accepts` entry against the only shape this step pays:
 * x402 v2 `exact` for USDC on the Base rail. Returns the checked fields or
 * null when the entry is not acceptable (wrong scheme/network/asset, or a
 * malformed field).
 */
function checkRequirement(entry: unknown): {
  amountRaw: bigint;
  payTo: string;
  validitySeconds: number;
} | null {
  if (!isRecord(entry)) {
    return null;
  }
  const req = entry as RawRequirement;
  if (req.scheme !== "exact") {
    return null;
  }
  if (req.network !== BASE_RAIL.network) {
    return null;
  }
  // The asset must name the rail's USDC contract, but the value is only ever
  // USED for comparison: the signature's verifyingContract comes from the
  // rail, so a seller-supplied asset string cannot redirect the signature.
  if (
    typeof req.asset !== "string" ||
    req.asset.toLowerCase() !== BASE_RAIL.asset.toLowerCase()
  ) {
    return null;
  }
  if (typeof req.amount !== "string" || !RAW_AMOUNT_RE.test(req.amount)) {
    return null;
  }
  const amountRaw = BigInt(req.amount);
  if (amountRaw <= BigInt(0)) {
    return null;
  }
  if (!isHexAddress(req.payTo)) {
    return null;
  }
  const maxTimeoutSeconds = req.maxTimeoutSeconds;
  if (
    typeof maxTimeoutSeconds !== "number" ||
    !Number.isFinite(maxTimeoutSeconds) ||
    maxTimeoutSeconds <= 0
  ) {
    return null;
  }
  return {
    amountRaw,
    payTo: req.payTo,
    validitySeconds: Math.min(
      Math.floor(maxTimeoutSeconds),
      MAX_VALIDITY_SECONDS
    ),
  };
}

/**
 * Parse an x402 v2 402 response body and check the first acceptable payment
 * requirement against the step's bounds. x402 v1 challenges are out of scope
 * and refused here.
 */
export function checkQuote(
  body: unknown,
  options: QuoteCheckOptions
): QuoteCheckResult {
  if (!isRecord(body)) {
    return {
      ok: false,
      code: "NOT_X402_V2",
      error: "Not an x402 v2 payment challenge: expected a JSON object body",
    };
  }
  if (body.x402Version !== 2) {
    return {
      ok: false,
      code: "NOT_X402_V2",
      error:
        "Not an x402 v2 payment challenge: x402Version 2 required (v1 challenges are not supported)",
    };
  }
  const accepts = body.accepts;
  if (!Array.isArray(accepts) || accepts.length === 0) {
    return {
      ok: false,
      code: "NO_ACCEPTABLE_REQUIREMENT",
      error: "402 response carries no payment requirements",
    };
  }

  let candidate: ReturnType<typeof checkRequirement> | null = null;
  for (const entry of accepts) {
    candidate = checkRequirement(entry);
    if (candidate) {
      break;
    }
  }
  if (!candidate) {
    return {
      ok: false,
      code: "NO_ACCEPTABLE_REQUIREMENT",
      error:
        "No acceptable payment requirement: only x402 v2 'exact' for USDC on Base (eip155:8453) is supported",
    };
  }

  const maxPriceRaw = parseUsdcToRaw(options.maxPriceUsdc.trim());
  if (maxPriceRaw === null) {
    return {
      ok: false,
      code: "INVALID_MAX_PRICE",
      error: `Invalid max price "${options.maxPriceUsdc}": expected a positive USDC amount with at most 6 decimals`,
    };
  }

  if (candidate.amountRaw >= maxPriceRaw) {
    return {
      ok: false,
      code: "AMOUNT_EXCEEDS_MAX_PRICE",
      error: `Quoted ${formatUsdc(candidate.amountRaw)} USDC is not under the step max price of ${formatUsdc(maxPriceRaw)} USDC`,
    };
  }
  if (candidate.amountRaw >= MAX_PAYMENT_USDC_RAW) {
    return {
      ok: false,
      code: "AMOUNT_EXCEEDS_CEILING",
      error: `Quoted ${formatUsdc(candidate.amountRaw)} USDC is not under the 100 USDC per-payment ceiling`,
    };
  }

  const expectedPayTo = options.expectedPayTo?.trim();
  if (expectedPayTo) {
    if (!isHexAddress(expectedPayTo)) {
      return {
        ok: false,
        code: "PAYEE_MISMATCH",
        error: `Invalid expected payee "${expectedPayTo}": not a 0x address`,
      };
    }
    if (candidate.payTo.toLowerCase() !== expectedPayTo.toLowerCase()) {
      return {
        ok: false,
        code: "PAYEE_MISMATCH",
        error: `Quoted payee ${candidate.payTo} does not match the expected payee ${expectedPayTo}`,
      };
    }
  }

  return { ok: true, quote: candidate };
}

/** The EIP-3009 authorization fields that go into the PAYMENT-SIGNATURE payload. */
export type TransferAuthorization = {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
};

/**
 * Build the EIP-712 typed-data for an EIP-3009 TransferWithAuthorization
 * from the checked quote. Domain and types come from the agentic-wallet
 * signer (BASE_USDC_DOMAIN / AUTHORIZATION_TYPES) so the pair that drifted
 * in KEEP-364 stays one value. The nonce is freshly random per payment;
 * validAfter is 0 (immediately valid); validBefore is now + the capped
 * seller validity window.
 */
export function buildAuthorizationTypedData(
  quote: CheckedQuote,
  from: string,
  nowSec: number = Math.floor(Date.now() / 1000)
): { typedData: EIP712TypedData; authorization: TransferAuthorization } {
  const authorization: TransferAuthorization = {
    from,
    to: quote.payTo,
    value: quote.amountRaw.toString(),
    validAfter: "0",
    validBefore: String(nowSec + quote.validitySeconds),
    nonce: `0x${randomBytes(32).toString("hex")}`,
  };
  const typedData: EIP712TypedData = {
    domain: { ...BASE_USDC_DOMAIN },
    types: {
      EIP712Domain: [...AUTHORIZATION_TYPES.EIP712Domain],
      TransferWithAuthorization: [
        ...AUTHORIZATION_TYPES.TransferWithAuthorization,
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: { ...authorization },
  };
  return { typedData, authorization };
}

/**
 * Encode the x402 v2 PAYMENT-SIGNATURE header value: standard base64 of the
 * PaymentPayload JSON `{ x402Version: 2, payload: { signature,
 * authorization } }`. Matches `encodePaymentSignatureHeader` in @x402/core
 * (base64, not base64url).
 */
export function encodePaymentSignatureHeader(
  signature: string,
  authorization: TransferAuthorization
): string {
  const payload = {
    x402Version: 2,
    payload: { signature, authorization },
  };
  return Buffer.from(JSON.stringify(payload), "utf-8").toString("base64");
}

/**
 * Decode an x402 v2 PAYMENT-REQUIRED response header (standard base64 JSON).
 * Returns null when the header is absent or unusable.
 */
export function decodePaymentRequiredHeader(
  header: string | null
): unknown | null {
  if (!header) {
    return null;
  }
  try {
    return JSON.parse(Buffer.from(header, "base64").toString("utf-8"));
  } catch {
    return null;
  }
}
