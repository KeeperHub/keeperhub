/**
 * Scheduled broadcast + reconcile sweep for held Tempo payments.
 *
 * Called by the internal broadcast-due endpoint on a cron cadence. One pass:
 *   1. Expire pending rows whose on-chain window has lapsed (never broadcast).
 *   2. Broadcast rows whose scheduled `broadcastAt` has arrived, without waiting
 *      for the receipt (claim -> send -> mark 'broadcast').
 *   3. Reconcile previously-broadcast rows by checking their receipt, advancing
 *      them to 'confirmed' or 'failed'.
 *
 * Every broadcast funnels through the guarded `claimHeldPayment`, so running
 * several poller instances (or overlapping ticks) can never double-broadcast.
 */
import "server-only";

import { ErrorCategory, logInfo, logSystemWarn } from "@/lib/logging";
import {
  claimHeldPayment,
  expireDueHeldPayments,
  markBroadcast,
  markConfirmed,
  markFailed,
  selectBroadcastToReconcile,
  selectDueHeldPayments,
} from "@/lib/tempo/held-payments";
import { getErrorMessage } from "@/lib/utils";
import {
  broadcastStoredTempoTx,
  checkTempoReceipt,
} from "@/plugins/tempo/steps/tempo-tx-core";

const DEFAULT_LIMIT = 25;

export type BroadcastDueResult = {
  expired: number;
  broadcast: number;
  confirmed: number;
  failed: number;
  stillPending: number;
};

async function broadcastDueRows(limit: number): Promise<{
  broadcast: number;
  failed: number;
}> {
  let broadcast = 0;
  let failed = 0;
  const due = await selectDueHeldPayments(limit);
  for (const row of due) {
    const claimed = await claimHeldPayment(row.id);
    if (!claimed) {
      // Another poller won the claim; skip.
      continue;
    }
    try {
      const { hash } = await broadcastStoredTempoTx({
        chainId: claimed.chainId,
        serialized: claimed.serializedTx,
        expectedHash: claimed.precomputedHash,
        waitForConfirmation: false,
      });
      await markBroadcast(claimed.id, hash);
      broadcast += 1;
    } catch (error) {
      await markFailed(claimed.id, getErrorMessage(error));
      failed += 1;
    }
  }
  return { broadcast, failed };
}

async function reconcileBroadcastRows(limit: number): Promise<{
  confirmed: number;
  failed: number;
  stillPending: number;
}> {
  let confirmed = 0;
  let failed = 0;
  let stillPending = 0;
  const rows = await selectBroadcastToReconcile(limit);
  for (const row of rows) {
    if (!row.broadcastTxHash) {
      stillPending += 1;
      continue;
    }
    try {
      const status = await checkTempoReceipt({
        chainId: row.chainId,
        txHash: row.broadcastTxHash,
      });
      if (status === "confirmed") {
        await markConfirmed(row.id, row.broadcastTxHash);
        confirmed += 1;
      } else if (status === "reverted") {
        await markFailed(
          row.id,
          `Tempo transaction reverted (${row.broadcastTxHash})`
        );
        failed += 1;
      } else {
        stillPending += 1;
      }
    } catch (error) {
      logSystemWarn(
        ErrorCategory.NETWORK_RPC,
        "[Tempo Held] Receipt reconcile failed",
        error,
        { payment_id: row.id }
      );
      stillPending += 1;
    }
  }
  return { confirmed, failed, stillPending };
}

export async function processDueHeldPayments(opts?: {
  limit?: number;
}): Promise<BroadcastDueResult> {
  const limit = opts?.limit ?? DEFAULT_LIMIT;

  const expired = await expireDueHeldPayments();
  const sent = await broadcastDueRows(limit);
  const reconciled = await reconcileBroadcastRows(limit);

  const result: BroadcastDueResult = {
    expired,
    broadcast: sent.broadcast,
    confirmed: reconciled.confirmed,
    failed: sent.failed + reconciled.failed,
    stillPending: reconciled.stillPending,
  };
  logInfo("[Tempo Held] broadcast-due sweep complete", {
    expired: String(result.expired),
    broadcast: String(result.broadcast),
    confirmed: String(result.confirmed),
    failed: String(result.failed),
    still_pending: String(result.stillPending),
  });
  return result;
}
