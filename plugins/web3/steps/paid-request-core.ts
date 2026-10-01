/**
 * Core logic for the Paid Request (x402) step: call an endpoint, and when it
 * answers 402, pay the quoted USDC on Base from the org's Turnkey wallet and
 * call it again with the payment attached.
 *
 * IMPORTANT: This file must NOT contain "use step" or be a step file.
 *
 * This is the one workflow path that signs an EIP-3009 transfer
 * authorization with the org wallet. It never signs a payload it was handed:
 * the authorization is built in lib/payments/x402/buyer.ts from a requirement
 * that has already been checked against the step's max price, the optional
 * expected payee and a hard per-payment ceiling. It refuses to run inside a
 * marketplace-listed workflow, so a published template cannot pay its author
 * from the deployer's wallet.
 */
import "server-only";

import { eq } from "drizzle-orm";
import { isAddress } from "viem";
import {
  PolicyBlockedError,
  signTypedDataWithTurnkey,
  TurnkeyUpstreamError,
} from "@/lib/agentic-wallet/sign-typed-data";
import { toChecksumAddress } from "@/lib/address-utils";
import {
  isValidUsdcDecimal,
  usdcDecimalToRaw,
  usdcRawToDecimal,
} from "@/lib/billing/payg/usdc";
import { db } from "@/lib/db";
import { workflowExecutions, workflows } from "@/lib/db/schema";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import { getFeature } from "@/lib/features/registry";
import {
  parsePaymentRequired,
  readSettlementClaim,
  selectRequirement,
  signPayment,
} from "@/lib/payments/x402/buyer";
import { assertUrlIsPublic, SsrfBlockedError, safeFetch } from "@/lib/safe-fetch";
import { getOrganizationWallet } from "@/lib/web3/wallet-helpers";
import { resolveOrganizationContext } from "@/lib/web3/resolve-org-context";

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_CHARS = 256 * 1024;
const PAYMENT_HEADER = "PAYMENT-SIGNATURE";
const ALLOWED_METHODS = new Set(["GET", "POST"]);

export type PaidRequestCoreInput = {
  url: string;
  method?: string;
  body?: string;
  maxPriceUsdc: string;
  payTo?: string;
  _context?: {
    executionId?: string;
    organizationId?: string;
  };
};

export type PaidRequestResult =
  | {
      success: true;
      paid: boolean;
      httpStatus: number;
      data: unknown;
      payment?: {
        payTo: string;
        amountUsdc: string;
        network: string;
        asset: string;
        payer: string;
      };
      settlementClaim?: unknown;
    }
  | {
      success: false;
      error: string;
      errorClass: ExecutionErrorType;
      httpStatus?: number;
    };

type Failure = Extract<PaidRequestResult, { success: false }>;

function fail(
  error: string,
  errorClass: ExecutionErrorType,
  httpStatus?: number
): Failure {
  return { success: false, error, errorClass, httpStatus };
}

type ReadBody = { ok: true; text: string } | { ok: false; failure: Failure };

async function readBody(response: Response): Promise<ReadBody> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_CHARS) {
    return {
      ok: false,
      failure: fail(
        `Response declared ${declared} bytes, over the ${MAX_RESPONSE_CHARS} byte limit`,
        ExecutionErrorType.EXTERNAL,
        response.status
      ),
    };
  }
  const text = await response.text();
  if (text.length > MAX_RESPONSE_CHARS) {
    return {
      ok: false,
      failure: fail(
        `Response is over the ${MAX_RESPONSE_CHARS} character limit`,
        ExecutionErrorType.EXTERNAL,
        response.status
      ),
    };
  }
  return { ok: true, text };
}

function parseData(text: string): unknown {
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function send(
  url: string,
  method: string,
  body: string | undefined,
  extraHeaders: Record<string, string>
): Promise<Response | Failure> {
  try {
    await assertUrlIsPublic(url);
    const response = await safeFetch(url, {
      plugin: "web3",
      method,
      headers: {
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...extraHeaders,
      },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status >= 300 && response.status < 400) {
      return fail(
        `${url} answered with a redirect, which is not followed. Use the final URL.`,
        ExecutionErrorType.USER,
        response.status
      );
    }
    return response;
  } catch (error) {
    if (error instanceof SsrfBlockedError) {
      return fail(
        `${url} is not a public address`,
        ExecutionErrorType.USER
      );
    }
    return fail(
      `Request to ${url} failed: ${error instanceof Error ? error.message : String(error)}`,
      ExecutionErrorType.EXTERNAL
    );
  }
}

function isFailure(value: Response | Failure): value is Failure {
  return "success" in value;
}

async function isListedWorkflow(executionId: string): Promise<boolean> {
  const [row] = await db
    .select({ isListed: workflows.isListed })
    .from(workflowExecutions)
    .innerJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
    .where(eq(workflowExecutions.id, executionId))
    .limit(1);
  return row?.isListed ?? false;
}

type ValidInput = {
  url: string;
  method: string;
  body: string | undefined;
  maxAmountRaw: bigint;
  payTo: string | undefined;
};

function validateInput(input: PaidRequestCoreInput): ValidInput | Failure {
  let url: URL;
  try {
    url = new URL(input.url?.trim() ?? "");
  } catch {
    return fail("URL must be an absolute http(s) URL", ExecutionErrorType.USER);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return fail("URL must be an absolute http(s) URL", ExecutionErrorType.USER);
  }

  const method = (input.method ?? "GET").toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    return fail("Method must be GET or POST", ExecutionErrorType.USER);
  }
  const body = method === "POST" && input.body?.trim() ? input.body : undefined;

  const maxPrice = input.maxPriceUsdc?.trim() ?? "";
  const maxAmountRaw = isValidUsdcDecimal(maxPrice)
    ? usdcDecimalToRaw(maxPrice)
    : BigInt(0);
  if (maxAmountRaw <= BigInt(0)) {
    return fail(
      "Max price must be a USDC amount greater than zero, e.g. 0.05",
      ExecutionErrorType.USER
    );
  }

  const payTo = input.payTo?.trim() || undefined;
  if (payTo && !isAddress(payTo)) {
    return fail("Expected payee must be an address", ExecutionErrorType.USER);
  }

  return { url: url.toString(), method, body, maxAmountRaw, payTo };
}

export async function paidRequestCore(
  input: PaidRequestCoreInput
): Promise<PaidRequestResult> {
  // The direct node route does not consult feature gates, so the switch is
  // checked here as well as at workflow dispatch.
  if (!getFeature("action.paid-request").enabled) {
    return fail("Paid requests are not enabled yet", ExecutionErrorType.USER);
  }

  const valid = validateInput(input);
  if ("success" in valid) {
    return valid;
  }

  const executionId = input._context?.executionId;
  if (executionId && (await isListedWorkflow(executionId))) {
    return fail(
      "Paid requests are not allowed in marketplace-listed workflows",
      ExecutionErrorType.USER
    );
  }

  const first = await send(valid.url, valid.method, valid.body, {});
  if (isFailure(first)) {
    return first;
  }
  const firstBody = await readBody(first);
  if (!firstBody.ok) {
    return firstBody.failure;
  }

  if (first.status !== 402) {
    if (!first.ok) {
      return fail(
        `HTTP ${first.status} from ${valid.url}`,
        first.status >= 500 ? ExecutionErrorType.EXTERNAL : ExecutionErrorType.USER,
        first.status
      );
    }
    return {
      success: true,
      paid: false,
      httpStatus: first.status,
      data: parseData(firstBody.text),
    };
  }

  const paymentRequired = parsePaymentRequired(first.headers, firstBody.text);
  if (!paymentRequired) {
    return fail(
      "The endpoint answered 402 without an x402 v2 payment challenge",
      ExecutionErrorType.EXTERNAL,
      402
    );
  }
  const check = selectRequirement(paymentRequired, {
    maxAmountRaw: valid.maxAmountRaw,
    expectedPayTo: valid.payTo,
  });
  if (!check.ok) {
    return fail(check.reason, ExecutionErrorType.USER, 402);
  }

  const ctx = await resolveOrganizationContext(
    {
      executionId,
      organizationId: input._context?.organizationId,
    },
    "[paid-request]",
    "paid-request"
  );
  if (!ctx.success) {
    return fail(ctx.error, ExecutionErrorType.USER);
  }

  let wallet: { walletAddress: string; turnkeySubOrgId: string | null };
  try {
    wallet = await getOrganizationWallet(ctx.organizationId);
  } catch (error) {
    return fail(
      error instanceof Error ? error.message : "Failed to load organization wallet",
      ExecutionErrorType.USER
    );
  }
  const { turnkeySubOrgId } = wallet;
  if (!turnkeySubOrgId) {
    return fail(
      "Organization wallet is not Turnkey-backed; paid requests require a Turnkey wallet",
      ExecutionErrorType.USER
    );
  }
  const payer = toChecksumAddress(wallet.walletAddress);

  let paymentHeader: string;
  try {
    const signed = await signPayment({
      from: payer,
      paymentRequired,
      requirement: check.requirement,
      sign: (typedData) =>
        signTypedDataWithTurnkey(turnkeySubOrgId, payer, typedData),
    });
    paymentHeader = signed.header;
  } catch (error) {
    if (error instanceof PolicyBlockedError) {
      return fail(error.message, ExecutionErrorType.USER);
    }
    if (error instanceof TurnkeyUpstreamError) {
      return fail(error.message, ExecutionErrorType.SYSTEM);
    }
    return fail(
      `Signing the payment failed: ${error instanceof Error ? error.message : String(error)}`,
      ExecutionErrorType.SYSTEM
    );
  }

  const paid = await send(valid.url, valid.method, valid.body, {
    [PAYMENT_HEADER]: paymentHeader,
  });
  if (isFailure(paid)) {
    return paid;
  }
  const paidBody = await readBody(paid);
  if (!paidBody.ok) {
    return paidBody.failure;
  }
  if (!paid.ok) {
    return fail(
      `HTTP ${paid.status} from ${valid.url} after payment was sent`,
      paid.status >= 500 ? ExecutionErrorType.EXTERNAL : ExecutionErrorType.USER,
      paid.status
    );
  }

  return {
    success: true,
    paid: true,
    httpStatus: paid.status,
    data: parseData(paidBody.text),
    payment: {
      payTo: toChecksumAddress(check.requirement.payTo),
      amountUsdc: usdcRawToDecimal(check.amountRaw),
      network: check.requirement.network,
      asset: check.requirement.asset,
      payer,
    },
    settlementClaim: readSettlementClaim(paid.headers),
  };
}
