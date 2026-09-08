import "server-only";
import { getAddress, type Hex } from "viem";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { sleep } from "@/lib/sleep";
import { getTurnkeyClientForOrg } from "@/lib/turnkey/agentic-wallet";
import {
  formatRevertChain,
  type RevertChainEntry,
  SponsoredTxPendingError,
  SponsoredTxRevertError,
} from "@/lib/web3/turnkey-revert";
import { toCaip2 } from "@/lib/web3/turnkey-sponsorship-config";

/**
 * Wrapper around Turnkey's Gas Station / Transaction Management API.
 *
 * Turnkey's native sponsorship is NOT an ERC-4337 paymaster. It is a single
 * activity (`ethSendTransaction` with `sponsor: true`) that signs the
 * transaction with the sub-org's wallet, fills gas from Turnkey's Gas
 * Station, and broadcasts. The activity returns a `sendTransactionStatusId`
 * which we poll until the transaction is broadcast and a hash is available.
 *
 * Return contract:
 *   - `null` only for failures that happened BEFORE anything was broadcast
 *     (unsupported chain, `ethSendTransaction` rejected, or a terminal-failure
 *     status with no tx hash). Callers may safely fall back to direct signing.
 *   - `SponsoredTxRevertError` when the tx broadcast and reverted on-chain.
 *   - `SponsoredTxPendingError` when the send was accepted but we could not
 *     confirm its outcome within the wait window (Turnkey slow to broadcast,
 *     or its status API kept erroring). The tx may still land, so callers MUST
 *     NOT fall back -- doing so double-sends from the same wallet.
 */

const STATUS_POLL_INTERVAL_MS = 1000;
// Turnkey's Gas Station queues, gas-funds, and broadcasts, then inclusion waits
// on the mempool -- routinely longer than 30s under load. A short deadline made
// the poll return null and the caller re-send via direct signing, so a slow
// sponsored tx and its direct-signed retry both landed a block apart and the
// second reverted. Wait longer so a normal-but-slow send resolves to a real
// hash (or a real revert) instead of an ambiguous timeout.
const STATUS_POLL_TIMEOUT_MS = 120_000;
// Tolerate transient Turnkey status-API blips before giving up on confirmation.
const MAX_CONSECUTIVE_STATUS_ERRORS = 3;

type PollOptions = {
  timeoutMs?: number;
  intervalMs?: number;
};

// Turnkey's getSendTransactionStatus returns short status strings
// (INITIALIZED, BROADCASTING, BROADCASTED, INCLUDED, CONFIRMED, FINALIZED,
// FAILED, DROPPED, REJECTED). We treat these as failures; any other status
// that carries a tx hash means the send is broadcast and we wait on that hash.
const TERMINAL_FAILURE_STATUSES = new Set([
  "FAILED",
  "DROPPED",
  "REJECTED",
  "TIMEOUT",
  "REVERTED",
]);

export type TurnkeySponsoredTxParams = {
  subOrgId: string;
  walletAddress: string;
  chainId: number;
  to: string;
  value?: bigint;
  data?: Hex;
};

export type TurnkeySponsoredTxResult = {
  txHash: Hex;
  sendTransactionStatusId: string;
};

/**
 * Submit a sponsored EVM transaction via Turnkey Gas Station and wait
 * for the broadcast tx hash. Returns null on any failure so callers can
 * fall back to direct signing.
 */
export async function submitTurnkeySponsoredTransaction(
  params: TurnkeySponsoredTxParams,
  pollOptions?: PollOptions
): Promise<TurnkeySponsoredTxResult | null> {
  const caip2 = toCaip2(params.chainId);
  if (caip2 === null) {
    return null;
  }

  const turnkey = getTurnkeyClientForOrg(params.subOrgId);
  const client = turnkey.apiClient();

  let statusId: string;
  try {
    const submitResponse = await client.ethSendTransaction({
      organizationId: params.subOrgId,
      // Turnkey matches the signing resource on the EIP-55 checksummed address
      // (it is case-sensitive). The wallet address is stored lowercase in the
      // DB, so checksum it here or Turnkey rejects with "Could not find any
      // resource to sign with" and the caller falls back to direct signing.
      from: getAddress(params.walletAddress),
      sponsor: true,
      // Turnkey confirmed Arbitrum (eip155:42161) is supported on mainnet,
      // but the SDK v5.2.0 CAIP-2 enum has not been regenerated yet. Widen
      // the type until the SDK catches up; remove this cast once the enum
      // includes 42161.
      // biome-ignore lint/suspicious/noExplicitAny: SDK CAIP-2 enum lags Turnkey's confirmed chain coverage
      caip2: caip2 as any,
      to: params.to,
      value: params.value === undefined ? undefined : params.value.toString(),
      data: params.data,
    });

    statusId = submitResponse.sendTransactionStatusId;
  } catch (error) {
    logSystemError(
      ErrorCategory.EXTERNAL_SERVICE,
      "[Turnkey Sponsorship] ethSendTransaction failed",
      error,
      {
        service: "turnkey",
        chain_id: params.chainId.toString(),
      }
    );
    return null;
  }

  const txHash = await pollForTxHash(params.subOrgId, statusId, pollOptions);
  if (txHash === null) {
    return null;
  }

  return { txHash, sendTransactionStatusId: statusId };
}

async function pollForTxHash(
  subOrgId: string,
  sendTransactionStatusId: string,
  pollOptions?: PollOptions
): Promise<Hex | null> {
  const turnkey = getTurnkeyClientForOrg(subOrgId);
  const client = turnkey.apiClient();
  const timeoutMs = pollOptions?.timeoutMs ?? STATUS_POLL_TIMEOUT_MS;
  const intervalMs = pollOptions?.intervalMs ?? STATUS_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;

  let consecutiveStatusErrors = 0;

  while (Date.now() < deadline) {
    let response: Awaited<ReturnType<typeof client.getSendTransactionStatus>>;
    try {
      response = await client.getSendTransactionStatus({
        organizationId: subOrgId,
        sendTransactionStatusId,
      });
      consecutiveStatusErrors = 0;
    } catch (error) {
      logSystemError(
        ErrorCategory.EXTERNAL_SERVICE,
        "[Turnkey Sponsorship] getSendTransactionStatus failed",
        error,
        {
          service: "turnkey",
          send_transaction_status_id: sendTransactionStatusId,
        }
      );
      // The send was already accepted; a status blip does not mean it failed.
      // Retry a few times, then surface a pending error rather than returning
      // null (which would let the caller re-send and double-broadcast).
      consecutiveStatusErrors++;
      if (consecutiveStatusErrors >= MAX_CONSECUTIVE_STATUS_ERRORS) {
        throw new SponsoredTxPendingError({
          message:
            "Turnkey status API unavailable; sponsored transaction outcome unknown",
          sendTransactionStatusId,
        });
      }
      await sleep(intervalMs);
      continue;
    }

    const hash = response.eth?.txHash;
    const hasFailure =
      TERMINAL_FAILURE_STATUSES.has(response.txStatus) ||
      Boolean(response.txError) ||
      Boolean(response.error);

    if (hasFailure) {
      // Post-broadcast revert: txHash is set, the underlying call is already
      // on-chain. Throw a typed error carrying Turnkey's structured revert
      // chain so callers can surface the real revert reason and skip the
      // direct-signing fallback (which would just revert again).
      if (hash !== undefined && hash !== "") {
        const revertChain = (response.error?.eth?.revertChain ??
          []) as readonly RevertChainEntry[];
        const message = response.txError ?? formatRevertChain(revertChain);
        throw new SponsoredTxRevertError({
          message,
          txHash: hash as Hex,
          sendTransactionStatusId,
          revertChain,
        });
      }

      // Pre-broadcast failure (policy denial, gas-cap exhaustion, simulation
      // error). Nothing happened on-chain; return null so the caller falls
      // back to direct signing.
      logSystemError(
        ErrorCategory.EXTERNAL_SERVICE,
        "[Turnkey Sponsorship] Transaction terminated before broadcast",
        new Error(response.txError ?? response.txStatus),
        {
          service: "turnkey",
          send_transaction_status_id: sendTransactionStatusId,
          tx_status: response.txStatus,
        }
      );
      return null;
    }

    // Turnkey assigned a hash -> the tx is broadcast and we own it. Return it
    // so the caller waits for the receipt and reports the real on-chain outcome
    // (included or reverted) as the node result, and never re-sends.
    if (hash !== undefined && hash !== "") {
      return hash as Hex;
    }

    await sleep(intervalMs);
  }

  // Deadline hit without a terminal status. The send was accepted and may
  // still broadcast, so surface a pending error instead of null: the caller
  // must fail the step rather than re-send via direct signing.
  logSystemError(
    ErrorCategory.EXTERNAL_SERVICE,
    "[Turnkey Sponsorship] Timed out waiting for tx hash",
    new Error(`No terminal status within ${timeoutMs}ms`),
    {
      service: "turnkey",
      send_transaction_status_id: sendTransactionStatusId,
    }
  );
  throw new SponsoredTxPendingError({
    message: `Sponsored transaction not confirmed within ${timeoutMs}ms; outcome unknown`,
    sendTransactionStatusId,
  });
}
