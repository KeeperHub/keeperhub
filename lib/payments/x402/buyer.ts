import "server-only";

import { randomBytes } from "node:crypto";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import type {
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
} from "@x402/core/types";
import { getAddress, isAddress } from "viem";
import {
  AUTHORIZATION_TYPES,
  BASE_USDC_DOMAIN,
} from "@/lib/agentic-wallet/sign";
import { usdcRawToDecimal } from "@/lib/billing/payg/usdc";
import { BASE_RAIL } from "@/lib/payments/rails";

/**
 * Buyer side of x402: read a 402 challenge, pick the Base USDC `exact`
 * requirement, check it against the caller's limits, and build the EIP-3009
 * authorization that pays it.
 *
 * The typed data is assembled here from the checked requirement, never taken
 * from the seller. Domain and types are the Base USDC constants the
 * agentic-wallet signer already uses, so a seller cannot point the signature
 * at another token or chain by editing `extra` or `asset`.
 */

const PAYMENT_REQUIRED_HEADER = "payment-required";

// x402 v2 is the only version accepted: v1 challenges carry a different
// requirement shape and a different payment header.
const SUPPORTED_X402_VERSION = 2;

// Ceiling on the authorization's validity window. The seller's
// maxTimeoutSeconds is honoured only when it is shorter.
export const MAX_VALIDITY_SECONDS = 600;

// Hard per-payment ceiling in USDC base units (100 USDC), applied on top of
// whatever max price the workflow sets. The org wallet carries no Turnkey
// signing policy, so this is the last bound before the signature.
export const MAX_PAYMENT_RAW = BigInt(100_000_000);

const UINT_RE = /^\d+$/;

export type PaymentLimits = {
  /** Most the caller will pay, in USDC base units. */
  maxAmountRaw: bigint;
  /** When set, the requirement's payTo must equal it. */
  expectedPayTo?: string;
};

export type RequirementCheck =
  | { ok: true; requirement: PaymentRequirements; amountRaw: bigint }
  | { ok: false; reason: string };

export type SignedPayment = {
  header: string;
  payload: PaymentPayload;
};

/**
 * Reads the challenge from the `PAYMENT-REQUIRED` header, falling back to a
 * JSON body. Returns null when neither carries an x402 v2 challenge.
 */
export function parsePaymentRequired(
  headers: Headers,
  bodyText: string
): PaymentRequired | null {
  const header = headers.get(PAYMENT_REQUIRED_HEADER);
  if (header) {
    try {
      return asPaymentRequired(decodePaymentRequiredHeader(header));
    } catch {
      return null;
    }
  }
  if (!bodyText) {
    return null;
  }
  try {
    return asPaymentRequired(JSON.parse(bodyText));
  } catch {
    return null;
  }
}

function asPaymentRequired(value: unknown): PaymentRequired | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const candidate = value as Partial<PaymentRequired>;
  if (
    candidate.x402Version !== SUPPORTED_X402_VERSION ||
    !Array.isArray(candidate.accepts)
  ) {
    return null;
  }
  return candidate as PaymentRequired;
}

function isBaseUsdcExact(requirement: PaymentRequirements): boolean {
  return (
    requirement.scheme === "exact" &&
    requirement.network === BASE_RAIL.network &&
    typeof requirement.asset === "string" &&
    requirement.asset.toLowerCase() === BASE_RAIL.asset.toLowerCase()
  );
}

/**
 * Picks the first Base USDC `exact` requirement and checks it against the
 * limits. Every refusal names the field that failed, since the seller
 * controls all of them.
 */
export function selectRequirement(
  paymentRequired: PaymentRequired,
  limits: PaymentLimits
): RequirementCheck {
  const requirement = paymentRequired.accepts.find(isBaseUsdcExact);
  if (!requirement) {
    return {
      ok: false,
      reason: "The endpoint does not accept an exact USDC payment on Base",
    };
  }

  if (
    typeof requirement.amount !== "string" ||
    !UINT_RE.test(requirement.amount)
  ) {
    return { ok: false, reason: "The quoted amount is not a whole number" };
  }
  const amountRaw = BigInt(requirement.amount);
  if (amountRaw <= BigInt(0)) {
    return { ok: false, reason: "The quoted amount must be greater than zero" };
  }
  if (amountRaw > limits.maxAmountRaw) {
    return {
      ok: false,
      reason: `The quoted price ${usdcRawToDecimal(amountRaw)} USDC is over the max price ${usdcRawToDecimal(limits.maxAmountRaw)} USDC`,
    };
  }
  if (amountRaw > MAX_PAYMENT_RAW) {
    return {
      ok: false,
      reason: `The quoted price ${usdcRawToDecimal(amountRaw)} USDC is over the ${usdcRawToDecimal(MAX_PAYMENT_RAW)} USDC limit per payment`,
    };
  }

  if (typeof requirement.payTo !== "string" || !isAddress(requirement.payTo)) {
    return { ok: false, reason: "The payee is not a valid address" };
  }
  if (
    limits.expectedPayTo &&
    requirement.payTo.toLowerCase() !== limits.expectedPayTo.toLowerCase()
  ) {
    return {
      ok: false,
      reason: `The payee ${requirement.payTo} is not the expected payee ${limits.expectedPayTo}`,
    };
  }

  return { ok: true, requirement, amountRaw };
}

/** EIP-3009 TransferWithAuthorization paying exactly what was checked. */
export function buildTransferAuthorization(params: {
  from: string;
  requirement: PaymentRequirements;
  nowSeconds: number;
  nonce: `0x${string}`;
}): {
  authorization: Record<string, string>;
  typedData: {
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
  };
} {
  const validity = Math.min(
    Math.max(Math.floor(params.requirement.maxTimeoutSeconds), 1),
    MAX_VALIDITY_SECONDS
  );
  const authorization = {
    from: getAddress(params.from),
    to: getAddress(params.requirement.payTo),
    value: params.requirement.amount,
    validAfter: "0",
    validBefore: String(params.nowSeconds + validity),
    nonce: params.nonce,
  };
  return {
    authorization,
    typedData: {
      domain: { ...BASE_USDC_DOMAIN },
      types: AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: { ...authorization },
    },
  };
}

/**
 * Signs the authorization with the supplied signer and wraps it as the
 * `PAYMENT-SIGNATURE` header value.
 */
export async function signPayment(params: {
  from: string;
  paymentRequired: PaymentRequired;
  requirement: PaymentRequirements;
  sign: (
    typedData: ReturnType<typeof buildTransferAuthorization>["typedData"]
  ) => Promise<string>;
  now?: () => number;
}): Promise<SignedPayment> {
  const nowSeconds = Math.floor((params.now?.() ?? Date.now()) / 1000);
  const nonce = `0x${randomBytes(32).toString("hex")}` as const;
  const { authorization, typedData } = buildTransferAuthorization({
    from: params.from,
    requirement: params.requirement,
    nowSeconds,
    nonce,
  });
  const signature = await params.sign(typedData);
  const payload: PaymentPayload = {
    x402Version: SUPPORTED_X402_VERSION,
    resource: params.paymentRequired.resource,
    accepted: params.requirement,
    payload: { authorization, signature },
  };
  return { header: encodePaymentSignatureHeader(payload), payload };
}

const PAYMENT_RESPONSE_HEADER = "payment-response";

/**
 * Decodes the seller's `PAYMENT-RESPONSE` header. This is the seller's own
 * claim about settlement; nothing here checks it against the chain.
 */
export function readSettlementClaim(headers: Headers): unknown {
  const header = headers.get(PAYMENT_RESPONSE_HEADER);
  if (!header) {
    return undefined;
  }
  try {
    return decodePaymentResponseHeader(header);
  } catch {
    return undefined;
  }
}
