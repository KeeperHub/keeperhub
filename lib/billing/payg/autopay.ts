import "server-only";

import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import type { ClientEvmSigner } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { toChecksumAddress } from "@/lib/address-utils";
import { USDC_BASE_ADDRESS } from "@/lib/agentic-wallet/constants";
import {
  type EIP712TypedData,
  signTypedDataWithTurnkey,
} from "@/lib/agentic-wallet/sign-typed-data";
import { facilitatorClient } from "@/lib/payments/x402/server";
import { getOrganizationWallet } from "@/lib/web3/wallet-helpers";
import { hasSufficientUsdc } from "./balance";
import { getPaygSettings } from "./config-store";
import {
  evmNetworkId,
  PAYG_PAYMENT_STATUS,
  PAYG_RESOURCE_URL,
  USDC_EIP712_NAME,
  USDC_EIP712_VERSION,
  X402_EXACT_SCHEME,
} from "./constants";
import type { PaygBlockReason } from "./errors";
import {
  claimPaygPayment,
  findPaygPayment,
  getPaygSpentRaw,
  markPaygPaymentSettled,
  releasePaygClaim,
} from "./payments";
import { getPaygPeriod, startOfUtcDay } from "./period";
import { getPaygExecutionPriceRaw } from "./pricing";
import { getPaygTreasuryOrNull } from "./treasury";

export type AutopayResult =
  | { ok: true; txHash: string; amountRaw: bigint }
  | { ok: false; reason: PaygBlockReason };

// The facilitator settle response shape we depend on (from @x402). Kept local
// so a minor SDK response change surfaces here rather than deep in a call.
type SettleLike = {
  success?: boolean;
  transaction?: string;
  errorReason?: string;
};

function classifySettleFailure(reason: string): PaygBlockReason {
  const lower = reason.toLowerCase();
  if (
    lower.includes("insufficient") ||
    lower.includes("balance") ||
    lower.includes("funds")
  ) {
    return "insufficient_funds";
  }
  return "payment_failed";
}

/**
 * Settle `amountRaw` USDC from the org wallet to the treasury via the x402
 * facilitator (gasless: the facilitator submits the EIP-3009
 * transferWithAuthorization on-chain and pays gas). The org Turnkey key signs
 * the authorization; nothing is charged to the org for gas.
 *
 * NOTE: the on-chain settlement path requires the facilitator API keys and can
 * only be validated end-to-end on a testnet, not in unit/local runs.
 */
async function settleViaFacilitator(params: {
  subOrgId: string;
  payerAddress: string;
  treasury: string;
  amountRaw: bigint;
  chainId: number;
}): Promise<
  { ok: true; txHash: string } | { ok: false; reason: PaygBlockReason }
> {
  const clientSigner: ClientEvmSigner = {
    address: params.payerAddress as `0x${string}`,
    signTypedData: (message) =>
      signTypedDataWithTurnkey(
        params.subOrgId,
        params.payerAddress,
        message as EIP712TypedData
      ).then((signature) => signature as `0x${string}`),
  };

  const resource = {
    url: PAYG_RESOURCE_URL,
    description: "Pay-as-you-go execution",
    mimeType: "application/json",
  };
  const requirements = {
    scheme: X402_EXACT_SCHEME,
    network: evmNetworkId(params.chainId),
    amount: params.amountRaw.toString(),
    asset: USDC_BASE_ADDRESS,
    payTo: params.treasury,
    maxTimeoutSeconds: 300,
    extra: { name: USDC_EIP712_NAME, version: USDC_EIP712_VERSION },
  } as PaymentRequirements;

  try {
    // The exact scheme signs the EIP-3009 authorization and returns only
    // { x402Version, payload }. The facilitator's v2 settle schema needs the
    // complete payment payload, so wrap it with the accepted requirements and
    // resource, exactly as the x402 client assembles it.
    const partial = (await new ExactEvmScheme(
      clientSigner
    ).createPaymentPayload(2, requirements)) as unknown as {
      x402Version: number;
      payload: Record<string, unknown>;
    };
    const paymentPayload = {
      x402Version: partial.x402Version,
      payload: partial.payload,
      resource,
      accepted: requirements,
    } as unknown as PaymentPayload;
    const settle = (await facilitatorClient.settle(
      paymentPayload,
      requirements
    )) as SettleLike;
    if (!(settle.success && settle.transaction)) {
      return {
        ok: false,
        reason: classifySettleFailure(settle.errorReason ?? "unknown"),
      };
    }
    return { ok: true, txHash: settle.transaction };
  } catch (error) {
    return {
      ok: false,
      reason: classifySettleFailure(
        error instanceof Error ? error.message : String(error)
      ),
    };
  }
}

/**
 * Charge one PAYG execution: enforce the daily + period spend caps, settle the
 * per-execution price to the treasury, and record the payment. Returns the
 * block reason instead of throwing so the caller can surface a clear message
 * and record it on the run.
 */
export async function autopayForExecution(params: {
  organizationId: string;
  executionId: string;
}): Promise<AutopayResult> {
  const { organizationId, executionId } = params;

  const config = await getPaygSettings(organizationId);

  // Idempotency: never settle a second on-chain transfer for one execution.
  // A settled row returns its recorded tx; a pending row means another attempt
  // is mid-settle (or a prior attempt crashed after settling), so refuse rather
  // than risk a duplicate transfer -- x402 mints a fresh EIP-3009 nonce per
  // call, so a re-settle is not idempotent on-chain.
  const existing = await findPaygPayment(organizationId, executionId);
  if (existing) {
    return settledOrRefuse(existing);
  }

  const priceRaw = getPaygExecutionPriceRaw();
  const treasury = getPaygTreasuryOrNull(config.chainId);
  if (priceRaw <= BigInt(0) || !treasury) {
    return { ok: false, reason: "not_eligible" };
  }

  const wallet = await getOrganizationWallet(organizationId).catch(() => null);
  if (!wallet?.turnkeySubOrgId) {
    return { ok: false, reason: "not_eligible" };
  }

  // A cap of 0 can never accommodate a charge, so refuse before claiming. This
  // keeps "spend nothing" independent of the window arithmetic below (a claim
  // made just before UTC midnight falls outside the new day's window, which
  // would otherwise let a single charge through) and saves an insert/delete on
  // every execution.
  const zeroCap = zeroCapBlock(config);
  if (zeroCap) {
    return { ok: false, reason: zeroCap };
  }

  // Stop an unfundable run before it costs a Turnkey signature and a
  // facilitator round-trip. Unknown (unsupported chain, RPC failure) falls
  // through and settles as before, so a flaky read never blocks a payer.
  const funded = await hasSufficientUsdc({
    payerAddress: wallet.walletAddress,
    amountRaw: priceRaw,
    chainId: config.chainId,
  });
  if (funded === false) {
    return { ok: false, reason: "insufficient_funds" };
  }

  // Claim the (org, execution) slot with a pending row before settling. The
  // unique constraint makes this the idempotency latch: exactly one caller wins
  // the insert and settles; a concurrent caller loses and backs off. The
  // pending row also reserves its amount against the spend caps below.
  const claimed = await claimPaygPayment({
    organizationId,
    executionId,
    amountRaw: priceRaw.toString(),
    chainId: config.chainId,
    payerAddress: wallet.walletAddress,
    treasuryAddress: treasury,
    status: PAYG_PAYMENT_STATUS.pending,
  });
  if (!claimed) {
    const owner = await findPaygPayment(organizationId, executionId);
    return owner
      ? settledOrRefuse(owner)
      : { ok: false, reason: "payment_failed" };
  }

  // Enforce the spend caps against the reserved total (settled + pending, which
  // now includes this claim). Release the claim on a breach so it holds neither
  // the idempotency slot nor its reserved cap amount.
  const capBlock = await checkCapsReserved(organizationId, config);
  if (capBlock) {
    await releasePaygClaim(organizationId, executionId);
    return { ok: false, reason: capBlock };
  }

  const settlement = await settleViaFacilitator({
    subOrgId: wallet.turnkeySubOrgId,
    // Turnkey's signWith lookup is case-sensitive; the org wallet is stored
    // lowercase, so checksum it before signing with our own wallet.
    payerAddress: toChecksumAddress(wallet.walletAddress),
    treasury,
    amountRaw: priceRaw,
    chainId: config.chainId,
  });
  if (!settlement.ok) {
    await releasePaygClaim(organizationId, executionId);
    return { ok: false, reason: settlement.reason };
  }

  await markPaygPaymentSettled(organizationId, executionId, settlement.txHash);
  return { ok: true, txHash: settlement.txHash, amountRaw: priceRaw };
}

/** Resolve an existing payment row into a result: its tx when settled,
 * otherwise refuse so a pending or unfinished charge is never re-settled. */
function settledOrRefuse(existing: {
  txHash: string | null;
  amountRaw: string;
  status: string;
}): AutopayResult {
  if (existing.status === PAYG_PAYMENT_STATUS.settled && existing.txHash) {
    return {
      ok: true,
      txHash: existing.txHash,
      amountRaw: BigInt(existing.amountRaw),
    };
  }
  return { ok: false, reason: "payment_failed" };
}

/** The cap set to 0, which no charge can ever fit under, or null. */
function zeroCapBlock(config: {
  dailyCapRaw: string;
  periodCapRaw: string;
}): PaygBlockReason | null {
  if (BigInt(config.dailyCapRaw) === BigInt(0)) {
    return "daily_cap";
  }
  if (BigInt(config.periodCapRaw) === BigInt(0)) {
    return "period_cap";
  }
  return null;
}

/**
 * The daily/period cap breached by the reserved total (settled + pending), or
 * null when both are within their configured caps. Every cap is enforced; a
 * cap of 0 is refused earlier, before the claim.
 */
async function checkCapsReserved(
  organizationId: string,
  config: { dailyCapRaw: string; periodCapRaw: string; startedAt: Date }
): Promise<PaygBlockReason | null> {
  const dailyCapRaw = BigInt(config.dailyCapRaw);
  const reservedToday = await getPaygSpentRaw(
    organizationId,
    startOfUtcDay(),
    undefined,
    { includePending: true }
  );
  if (reservedToday > dailyCapRaw) {
    return "daily_cap";
  }

  const periodCapRaw = BigInt(config.periodCapRaw);
  const period = getPaygPeriod(config.startedAt);
  const reservedPeriod = await getPaygSpentRaw(
    organizationId,
    period.start,
    period.end,
    { includePending: true }
  );
  if (reservedPeriod > periodCapRaw) {
    return "period_cap";
  }

  return null;
}
