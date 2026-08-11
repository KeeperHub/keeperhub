/**
 * Release a held Tempo payment now (claim, broadcast, wait for the receipt).
 *
 * The single "release and wait" path shared by the manual workflow action
 * (broadcast-held-payment step) and the session endpoint. The scheduled poller
 * uses its own fire-and-reconcile path in broadcast-due.ts instead.
 *
 * Every release funnels through the guarded `claimHeldPayment`, so a payment
 * can never be broadcast twice: the loser of the claim gets `not-pending`.
 */
import "server-only";

import {
  claimHeldPayment,
  getHeldPaymentForOrg,
  markConfirmed,
  markFailed,
} from "@/lib/tempo/held-payments";
import { getErrorMessage } from "@/lib/utils";
import { broadcastStoredTempoTx } from "@/plugins/tempo/steps/tempo-tx-core";

export type ReleaseHeldPaymentResult =
  | {
      ok: true;
      paymentId: string;
      transactionHash: string;
      from: string;
      to: string;
      chainId: number;
    }
  | {
      ok: false;
      reason: "not-found" | "expired" | "not-pending" | "broadcast-failed";
      error: string;
      /** Current row status, for surfacing to the caller. */
      status?: string;
    };

export async function releaseHeldPaymentNow(params: {
  paymentId: string;
  organizationId: string;
  userId?: string;
}): Promise<ReleaseHeldPaymentResult> {
  const { paymentId, organizationId, userId } = params;

  const existing = await getHeldPaymentForOrg(paymentId, organizationId);
  if (!existing) {
    return {
      ok: false,
      reason: "not-found",
      error: `Held payment ${paymentId} was not found for this organization.`,
    };
  }
  if (existing.validBefore <= Math.floor(Date.now() / 1000)) {
    return {
      ok: false,
      reason: "expired",
      error:
        "This held payment's validity window has closed; it can no longer be broadcast.",
      status: existing.status,
    };
  }

  const claimed = await claimHeldPayment(paymentId, organizationId);
  if (!claimed) {
    return {
      ok: false,
      reason: "not-pending",
      error: `Held payment ${paymentId} is not pending (status: ${existing.status}); it cannot be broadcast.`,
      status: existing.status,
    };
  }

  try {
    const { hash } = await broadcastStoredTempoTx({
      chainId: claimed.chainId,
      userId,
      serialized: claimed.serializedTx,
      expectedHash: claimed.precomputedHash,
      waitForConfirmation: true,
    });
    await markConfirmed(claimed.id, hash);
    return {
      ok: true,
      paymentId: claimed.id,
      transactionHash: hash,
      from: claimed.fromAddress,
      to: claimed.toAddress,
      chainId: claimed.chainId,
    };
  } catch (error) {
    const message = getErrorMessage(error);
    await markFailed(claimed.id, message);
    return {
      ok: false,
      reason: "broadcast-failed",
      error: message,
      status: "failed",
    };
  }
}
