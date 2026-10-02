/**
 * POST /api/agentic-wallet/sign
 *
 * HMAC-authenticated signing proxy. The agent client signs raw bytes with its
 * per-sub-org HMAC secret; the server resolves the sub-org, classifies the
 * operation risk, and either (a) creates an approval-request row (ask), (b)
 * returns 403 (block), or (c) proxies a Turnkey signRawPayload call and
 * returns the 65-byte EIP-3009 / MPP proof signature.
 *
 * Satisfies PAY-04 (all Turnkey signing server-side; agents never hold the
 * Turnkey API key).
 *
 * Request body: { chain: "base" | "tempo", paymentChallenge: {...} }
 * Auto-tier response: 200 { signature }
 * Ask-tier response:  202 { approvalRequestId }
 * Block responses:    403 { error, code: "RISK_BLOCKED" | "POLICY_BLOCKED" }
 * Upstream errors:    502 { error, code: "TURNKEY_UPSTREAM" }
 *
 * T-33-sign-spoofwallet mitigation: the wallet address used for signing is
 * resolved from the DB keyed on the HMAC-verified sub-org id. The request
 * body is NEVER trusted for the wallet address; that prevents a caller from
 * signing on behalf of a different sub-org.
 *
 * T-33-02 mitigation: logSystemError metadata carries only endpoint + sub-org
 * id -- never the raw body, the signature, or the HMAC secret.
 */
import { eq } from "drizzle-orm";
import { Challenge } from "mppx";
import {
  createApprovalRequest,
  deriveApprovalBinding,
} from "@/lib/agentic-wallet/approval";
import {
  ALLOWED_TEMPO_CHAIN_IDS,
  BASE_CHAIN_ID,
  TEMPO_MAINNET_CHAIN_ID,
  USDC_BASE_ADDRESS,
  USDC_TEMPO_ADDRESS,
} from "@/lib/agentic-wallet/constants";
import { reserveSpend, rollbackSpend } from "@/lib/agentic-wallet/daily-spend";
import { verifyHmacRequest } from "@/lib/agentic-wallet/hmac";
import { classifyRisk } from "@/lib/agentic-wallet/risk";
import {
  PolicyBlockedError,
  signMppProof,
  signMppTransaction,
  signX402Challenge,
  TurnkeyUpstreamError,
} from "@/lib/agentic-wallet/sign";
import { verifyWorkflowBinding } from "@/lib/agentic-wallet/workflow-binding";
import { db } from "@/lib/db";
import { agenticWallets } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { enforceAgenticWalletPolicy } from "@/lib/policy/agentic-wallet";
import { buildAuditMetadata, recordAuditEvent } from "@/lib/security/audit-log";

export const dynamic = "force-dynamic";

type SignRequestBody = {
  chain?: unknown;
  workflowSlug?: unknown;
  paymentChallenge?: unknown;
};

type Chain = "base" | "tempo";

function isChain(value: unknown): value is Chain {
  return value === "base" || value === "tempo";
}

// REVIEW HI-01 + ME-01: maximum validity window for an EIP-3009 x402
// authorization minted by /sign. 10 minutes is generous for any x402
// facilitator's settlement loop while capping replay exposure on a stolen
// HMAC secret.
const MAX_VALIDITY_SECONDS = 10 * 60;
// Small slack on validAfter to tolerate clock skew between agent and server.
const VALID_AFTER_FUTURE_SLACK_SECONDS = 60;

type TempoChargePeek =
  | { kind: "charge"; amountMicro: string; recipient: string }
  | { kind: "proof" }
  | { kind: "invalid" };

/**
 * Deserialize a Tempo MPP `serialized` challenge to recover the inner,
 * server-signed transfer amount + recipient. For the charge intent these are
 * the fund-moving values (`signMppTransaction` signs `request.amount` to
 * `request.recipient`); the outer caller-supplied `paymentChallenge.amount` /
 * `payTo` are 0/empty on Tempo and must NOT be trusted. Proof-intent
 * challenges move no funds. Malformed input is reported as invalid so the
 * caller gets a 400 rather than silently skipping the amount checks.
 */
function peekTempoCharge(serialized: string): TempoChargePeek {
  try {
    const input = serialized.startsWith("Payment ")
      ? serialized
      : `Payment ${serialized}`;
    const parsed = Challenge.deserialize(input);
    if (parsed.intent !== "charge") {
      return { kind: "proof" };
    }
    const request = parsed.request as unknown as {
      recipient?: unknown;
      amount?: unknown;
    };
    const amount = request?.amount;
    if (
      typeof request?.recipient !== "string" ||
      (typeof amount !== "string" &&
        typeof amount !== "number" &&
        typeof amount !== "bigint")
    ) {
      return { kind: "invalid" };
    }
    return {
      kind: "charge",
      amountMicro: String(amount),
      recipient: request.recipient,
    };
  } catch {
    return { kind: "invalid" };
  }
}

function isNonNegativeSafeInt(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
  );
}

function validateX402Validity(
  validAfterRaw: unknown,
  validBeforeRaw: unknown
): string | null {
  if (!isNonNegativeSafeInt(validAfterRaw)) {
    return "validAfter must be a non-negative integer";
  }
  if (!isNonNegativeSafeInt(validBeforeRaw)) {
    return "validBefore must be a non-negative integer";
  }
  const now = Math.floor(Date.now() / 1000);
  const validAfter = validAfterRaw;
  const validBefore = validBeforeRaw;
  if (validAfter > now + VALID_AFTER_FUTURE_SLACK_SECONDS) {
    return "validAfter must not be more than 60s in the future";
  }
  if (validBefore <= now) {
    return "validBefore must be in the future";
  }
  if (validBefore > now + MAX_VALIDITY_SECONDS) {
    return "validBefore must be within 10 minutes of now";
  }
  if (validBefore - validAfter > MAX_VALIDITY_SECONDS) {
    return "validity window (validBefore - validAfter) must be <= 600s";
  }
  return null;
}

export async function POST(request: Request): Promise<Response> {
  // HMAC signs raw bytes -- read text FIRST, never reach request.json().
  const rawBody = await request.text();
  const auth = await verifyHmacRequest(request, rawBody);
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  let body: SignRequestBody;
  try {
    body = JSON.parse(rawBody) as SignRequestBody;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!isChain(body.chain)) {
    return Response.json(
      { error: "chain must be 'base' or 'tempo'" },
      { status: 400 }
    );
  }
  if (
    !body.paymentChallenge ||
    typeof body.paymentChallenge !== "object" ||
    Array.isArray(body.paymentChallenge)
  ) {
    return Response.json(
      { error: "paymentChallenge required" },
      { status: 400 }
    );
  }

  const chain: Chain = body.chain;
  const challenge = body.paymentChallenge as Record<string, unknown>;

  // Phase 37 fix #2: workflowSlug is required so the server can derive
  // payTo + amount from the workflows registry (closes the HMAC-compromise
  // drain). Wallet client v0.1.5+ extracts the slug from the x402
  // resource.url and forwards it on every /sign call.
  const workflowSlug =
    typeof body.workflowSlug === "string" ? body.workflowSlug : undefined;
  if (!workflowSlug) {
    return Response.json(
      { error: "workflowSlug is required", code: "WORKFLOW_SLUG_REQUIRED" },
      { status: 400 }
    );
  }

  // Phase 37 fix #13: require the canonical `amount` key on the base path.
  // The legacy `value` alias was dropped because it allowed silent bypass of
  // the risk classifier (which reads `amount`) when callers used the wrong
  // key. Tempo (MPP) challenges don't carry an amount in the typed-data, so
  // the guard only fires on the base/x402 path.
  if (chain === "base") {
    const a = challenge.amount;
    if (typeof a !== "string" && typeof a !== "number") {
      return Response.json(
        {
          error: "paymentChallenge.amount must be a string or number",
          code: "BAD_AMOUNT",
        },
        { status: 400 }
      );
    }
  }

  // Caller-supplied payTo + amount are checked against the registry below.
  // String() normalises numeric/string amount inputs into the decimal-string
  // shape that downstream signing + the binding check both expect.
  const amountMicro = String(challenge.amount ?? "0");
  const callerPayTo = String(challenge.payTo ?? "");

  // REVIEW HI-01 + ME-01: bound the EIP-3009 validity window on the Base
  // (x402) path so a compromised HMAC secret cannot mint open-ended
  // authorizations. Also guards against NaN / non-integer inputs that
  // Turnkey would sign verbatim and x402 facilitators would later reject.
  // Rejecting (not capping) surfaces client bugs rather than silently
  // overwriting caller intent.
  //
  //   validAfter  must be a non-negative integer <= now
  //   validBefore must be a non-negative integer in (now, now + 600]
  //   total window (validBefore - validAfter) must be <= 600 seconds
  if (chain === "base") {
    const validityError = validateX402Validity(
      challenge.validAfter,
      challenge.validBefore
    );
    if (validityError) {
      return Response.json(
        { error: validityError, code: "INVALID_VALIDITY_WINDOW" },
        { status: 400 }
      );
    }
  }

  // Phase 37 fix #3: caller-supplied chainId restricted to the Tempo
  // mainnet/testnet enum on the tempo (MPP) path. The eth.eip_712.foreign-
  // chainid Turnkey policy is the upstream gate; this is the route-side
  // defence in depth and also catches malformed inputs before round-tripping
  // to Turnkey.
  let resolvedTempoChainId: number = TEMPO_MAINNET_CHAIN_ID;
  if (chain === "tempo") {
    const rawChainId = challenge.chainId;
    if (rawChainId === undefined) {
      resolvedTempoChainId = TEMPO_MAINNET_CHAIN_ID;
    } else if (
      typeof rawChainId === "number" &&
      ALLOWED_TEMPO_CHAIN_IDS.includes(rawChainId)
    ) {
      resolvedTempoChainId = rawChainId;
    } else {
      return Response.json(
        {
          error: `chainId must be one of ${ALLOWED_TEMPO_CHAIN_IDS.join(", ")}`,
          code: "BAD_CHAIN_ID",
        },
        { status: 400 }
      );
    }
  }

  // Phase 37 fix #2: server-derived recipient + amount via workflow registry.
  // The eth.eip_712.* Turnkey policy catches domain mismatches; this route-
  // side check is the recipient + amount gate that the policy DSL cannot
  // express. Fix-pack-2 R2: binding is chain-aware — tempo MPP proofs don't
  // carry payTo/amount, so tempo skips the equality checks but still looks up
  // the workflow's price (used for the R1 daily-spend deduction below).
  const binding = await verifyWorkflowBinding(
    workflowSlug,
    chain,
    callerPayTo,
    amountMicro
  );
  if (!binding.ok) {
    return Response.json(
      { error: binding.error, code: binding.code },
      { status: binding.status }
    );
  }

  // KEEP-736 / KEEP-737 (F-011 / F-012): on Tempo the fund-moving amount and
  // recipient live INSIDE the server-signed `serialized` MPP challenge, not in
  // the outer caller-supplied fields (which are 0/empty). verifyWorkflowBinding
  // can only equality-check the outer fields, so it skips amount/payTo on
  // Tempo. Deserialize the challenge up front and cross-check the inner amount
  // + recipient against the binding here -- the same equality the base/x402
  // path enforces -- so a stolen HMAC can't pair a cheap cover-workflow slug
  // with an expensive charge issued for a different workflow. The verified
  // inner amount then drives the risk classifier (a $50 charge must reach the
  // ask tier, not auto, even though the outer amount is 0).
  let effectiveAmountMicro = amountMicro;
  // For the ask tier, the approval binding + the row stored for /approve must
  // carry the real recipient/amount. On Tempo those live in `serialized`, so
  // enrich the challenge with the verified inner values; deriveApprovalBinding
  // (and the /approve re-derivation) read them from here, while `serialized`
  // is preserved for the eventual signing.
  let approvalChallenge: Record<string, unknown> = challenge;
  if (chain === "tempo") {
    const serialized =
      typeof challenge.serialized === "string" ? challenge.serialized : "";
    if (!serialized) {
      return Response.json(
        {
          error: "paymentChallenge.serialized is required for tempo",
          code: "MPP_CHALLENGE_MISSING",
        },
        { status: 400 }
      );
    }
    const peeked = peekTempoCharge(serialized);
    if (peeked.kind === "invalid") {
      return Response.json(
        {
          error: "paymentChallenge.serialized is not a valid MPP challenge",
          code: "MPP_CHALLENGE_INVALID",
        },
        { status: 400 }
      );
    }
    if (peeked.kind === "charge") {
      if (
        peeked.recipient.toLowerCase() !== binding.expectedPayTo.toLowerCase()
      ) {
        return Response.json(
          {
            error: "payTo does not match workflow creator wallet",
            code: "PAYTO_MISMATCH",
          },
          { status: 403 }
        );
      }
      let innerMicro: bigint;
      try {
        innerMicro = BigInt(peeked.amountMicro);
      } catch {
        return Response.json(
          { error: "amount is not a valid integer", code: "AMOUNT_MISMATCH" },
          { status: 403 }
        );
      }
      if (innerMicro !== BigInt(binding.expectedAmountMicro)) {
        return Response.json(
          {
            error: "amount does not match workflow priceUsdcPerCall",
            code: "AMOUNT_MISMATCH",
          },
          { status: 403 }
        );
      }
      effectiveAmountMicro = peeked.amountMicro;
      approvalChallenge = {
        ...challenge,
        recipient: peeked.recipient,
        amount: peeked.amountMicro,
      };
    }
  }

  // Wallet address resolution from DB -- NEVER trust any caller-supplied
  // wallet value (T-33-sign-spoofwallet).
  const rows = await db
    .select({
      walletAddressBase: agenticWallets.walletAddressBase,
      walletAddressTempo: agenticWallets.walletAddressTempo,
      organizationId: agenticWallets.organizationId,
    })
    .from(agenticWallets)
    .where(eq(agenticWallets.subOrgId, auth.subOrgId))
    .limit(1);
  if (rows.length === 0) {
    return Response.json({ error: "Sub-org not found" }, { status: 404 });
  }
  const walletAddress =
    chain === "base" ? rows[0].walletAddressBase : rows[0].walletAddressTempo;

  // The organization's own rules, before the risk tiers and before anything is
  // reserved or signed. Risk and the daily cap are this wallet's controls; a
  // policy is what the organization wrote, and until now it reached every other
  // way of moving money except this one.
  //
  // A wallet nobody has linked has no organization to ask, so nothing here can
  // govern it.
  if (rows[0].organizationId) {
    const policyRefusal = await enforceAgenticWalletPolicy({
      organizationId: rows[0].organizationId,
      subOrgId: auth.subOrgId,
      chainId: chain === "base" ? BASE_CHAIN_ID : resolvedTempoChainId,
      recipient: callerPayTo || undefined,
      tokenAddress: chain === "base" ? USDC_BASE_ADDRESS : USDC_TEMPO_ADDRESS,
      amountMicro: effectiveAmountMicro,
    });
    if (policyRefusal) {
      return policyRefusal;
    }
  }

  // Risk classification runs BEFORE the Turnkey round-trip so blocked / asked
  // operations never touch the signer.
  const risk = classifyRisk({
    chain,
    challenge: {
      amount: effectiveAmountMicro,
      payTo: callerPayTo,
      selector:
        typeof challenge.selector === "string" ? challenge.selector : undefined,
    },
  });

  if (risk === "block") {
    return Response.json(
      {
        error: "Operation blocked by risk classification",
        code: "RISK_BLOCKED",
      },
      { status: 403 }
    );
  }

  if (risk === "ask") {
    // Phase 37 fix B1 (nit-fix): delegate binding derivation to the shared
    // helper so /sign's ask-tier and /approval-request agree on recipient /
    // amount / chain / contract exactly. Tempo callers that supply
    // `recipient` instead of `payTo` bind consistently here and on /approve.
    const binding = deriveApprovalBinding(chain, approvalChallenge);
    if (!binding) {
      return Response.json(
        {
          error:
            "paymentChallenge must include a valid recipient and positive integer amount",
          code: "BINDING_REQUIRED",
        },
        { status: 422 }
      );
    }
    try {
      const ar = await createApprovalRequest({
        subOrgId: auth.subOrgId,
        riskLevel: "ask",
        operationPayload: { chain, paymentChallenge: approvalChallenge },
        binding,
      });
      return Response.json(
        { approvalRequestId: ar.id, status: "pending" },
        { status: 202 }
      );
    } catch (error) {
      logSystemError(
        ErrorCategory.DATABASE,
        "[Agentic] /sign ask-tier approval-request creation failed",
        error,
        {
          endpoint: "/api/agentic-wallet/sign",
          operation: "sign",
          subOrgId: auth.subOrgId,
        }
      );
      return Response.json(
        { error: "Failed to create approval request", code: "INTERNAL" },
        { status: 500 }
      );
    }
  }

  // risk === "auto": reserve daily spend before Turnkey. Phase 37 fix-pack-2 R1
  // bounds the HMAC-compromise drain. Amount comes from the server-derived
  // binding (never the caller) so a caller-supplied value can't understate the
  // reserved amount. On Turnkey success the reserve stays; on any failure the
  // rollback refunds the quota so transient upstream errors don't burn budget.
  const reserveAmountMicros = BigInt(binding.expectedAmountMicro);
  const reservation = await reserveSpend(auth.subOrgId, reserveAmountMicros);
  if (!reservation.ok) {
    return Response.json(
      {
        error: "Daily spend cap exceeded",
        code: "DAILY_CAP_EXCEEDED",
        retryAfter: reservation.retryAfter,
      },
      {
        status: 429,
        headers: { "Retry-After": String(reservation.retryAfter) },
      }
    );
  }

  try {
    let signature: string;
    if (chain === "base") {
      signature = await signX402Challenge(auth.subOrgId, walletAddress, {
        payTo: callerPayTo,
        amount: amountMicro,
        validAfter: Number(challenge.validAfter ?? 0),
        validBefore: Number(challenge.validBefore ?? 0),
        nonce: String(challenge.nonce ?? ""),
      });
    } else {
      const serialized =
        typeof challenge.serialized === "string" ? challenge.serialized : "";
      if (!serialized) {
        return Response.json(
          {
            error: "paymentChallenge.serialized is required for tempo",
            code: "MPP_CHALLENGE_MISSING",
          },
          { status: 400 }
        );
      }
      // Dispatch on MPP intent: zero-amount challenges use proof-mode
      // (EIP-712 Proof typed-data); non-zero charge intents use
      // transaction-mode (Tempo 0x76 transferWithMemo tx signed via raw
      // payload). `Challenge.deserialize` requires the full `Payment `
      // scheme prefix; signMppTransaction / signMppProof restore it
      // internally, so we peek at intent here with the client's form.
      const peeked = Challenge.deserialize(
        serialized.startsWith("Payment ") ? serialized : `Payment ${serialized}`
      );
      if (peeked.intent === "charge") {
        signature = await signMppTransaction(auth.subOrgId, walletAddress, {
          chainId: resolvedTempoChainId,
          serialized,
        });
      } else {
        signature = await signMppProof(auth.subOrgId, walletAddress, {
          chainId: resolvedTempoChainId,
          serialized,
        });
      }
    }
    // Auto-tier signature emitted. Record the operation (never the signature)
    // so the wallet's signing activity is auditable. Ask-tier signs only after
    // an approval, which is audited separately on /approve.
    await recordAuditEvent({
      actor: { userId: null, organizationId: null, authMethod: "internal" },
      action: "agentic_wallet.signed",
      resourceType: "agentic_wallet",
      resourceId: auth.subOrgId,
      after: {
        chain,
        risk,
        walletAddress,
        amountMicro: binding.expectedAmountMicro,
        payTo: callerPayTo,
      },
      metadata: buildAuditMetadata(request),
    });

    return Response.json({ signature }, { status: 200 });
  } catch (error) {
    // Fix-pack-3 N-2: only refund quota on TRANSIENT upstream failures. A
    // PolicyBlockedError is the attacker/caller proving they tried a denied
    // signature -- refunding quota would let a stolen HMAC probe policy
    // boundaries for free. Wrap rollback itself in a try/catch so a DB
    // hiccup during rollback doesn't escape this catch and leak an
    // uncontrolled 500 past the `instanceof` classification below.
    if (!(error instanceof PolicyBlockedError)) {
      try {
        await rollbackSpend(auth.subOrgId, reserveAmountMicros);
      } catch (rollbackError) {
        logSystemError(
          ErrorCategory.DATABASE,
          "[Agentic] /sign rollbackSpend failed",
          rollbackError,
          {
            endpoint: "/api/agentic-wallet/sign",
            operation: "sign",
            subOrgId: auth.subOrgId,
          }
        );
      }
    }
    if (error instanceof PolicyBlockedError) {
      // REVIEW HI-02: the `instanceof PolicyBlockedError` check is the
      // contract; the public response returns a fixed string + code so
      // upstream detail from error.message is never surfaced to callers.
      // Internal log carries the full error via logSystemError for debugging.
      logSystemError(
        ErrorCategory.EXTERNAL_SERVICE,
        "[Agentic] /sign policy blocked",
        error,
        {
          endpoint: "/api/agentic-wallet/sign",
          operation: "sign",
          subOrgId: auth.subOrgId,
        }
      );
      return Response.json(
        { error: "Policy blocked", code: "POLICY_BLOCKED" },
        { status: 403 }
      );
    }
    if (error instanceof TurnkeyUpstreamError) {
      logSystemError(
        ErrorCategory.EXTERNAL_SERVICE,
        "[Agentic] /sign upstream failure",
        error,
        {
          endpoint: "/api/agentic-wallet/sign",
          operation: "sign",
          subOrgId: auth.subOrgId,
        }
      );
      // REVIEW HI-02: do not forward upstream error text to HMAC callers.
      return Response.json(
        { error: "Upstream signer error", code: "TURNKEY_UPSTREAM" },
        { status: 502 }
      );
    }
    logSystemError(
      ErrorCategory.EXTERNAL_SERVICE,
      "[Agentic] /sign internal error",
      error,
      {
        endpoint: "/api/agentic-wallet/sign",
        operation: "sign",
        subOrgId: auth.subOrgId,
      }
    );
    return Response.json(
      { error: "Sign failed", code: "INTERNAL" },
      { status: 500 }
    );
  }
}
