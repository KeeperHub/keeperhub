import "server-only";
import { ethers, isError } from "ethers";
import { isConnectionRefusal } from "@/lib/rpc/connection-refusal";
import type { RpcProviderManager } from "@/lib/rpc/providers";
import type { BuilderRpcUrls } from "@/lib/rpc/rpc-config";
import { RPC_ENDPOINT, type RpcEndpoint } from "@/lib/rpc/rpc-endpoint";
import { sleep } from "@/lib/sleep";
import {
  type BuilderBroadcastResult,
  broadcastToBuilders,
} from "@/lib/web3/builder-broadcast";
import { broadcastToExtraRpcs } from "@/lib/web3/extra-broadcast";
import { type Delivery, isDuplicateMessage } from "@/lib/web3/json-rpc-answer";
import {
  isOnChainPendingError,
  OnChainPendingError,
} from "@/lib/web3/onchain-revert";
import {
  type Attempt,
  deliveryOfBroadcastError,
  routeFromEvidence,
  type SendReport,
  type SendRoute,
} from "@/lib/web3/send-route";

export type { SendReport, SendRoute } from "@/lib/web3/send-route";

/** The `route` / `included` output fields; empty when nothing was sent. */
export function sendReportFields<Route extends string = SendRoute>(report: {
  route?: Route;
  included?: boolean;
}): {
  route?: Route;
  included?: boolean;
} {
  return report.route
    ? { route: report.route, included: report.included === true }
    : {};
}

/** Where and when the signed transaction went out. Labels only, never URLs. */
export type BroadcastInfo = {
  // ISO time the regular RPC accepted the transaction; absent when only a builder took it.
  broadcastAt?: string;
  via?: RpcEndpoint;
  // Block builders that were also sent the transaction, when any were.
  builders?: BuilderBroadcastResult[];
};

type SubmitSignedOptions = {
  // Also send the signed bytes to these block builders, in parallel.
  builderRpcUrls?: BuilderRpcUrls;
};

export type BroadcastResult = {
  hash: string;
  response: ethers.TransactionResponse;
  /**
   * Populated only when on-chain reconciliation found the tx already mined
   * before/during our broadcast attempt. Callers may skip `response.wait()`.
   */
  preExistingReceipt?: ethers.TransactionReceipt;
  // From reconciliation: only the builders, when any were sent the bytes.
  broadcast?: BroadcastInfo;
};

/**
 * Thrown when broadcast failed AND on-chain reconciliation found no trace of
 * the signed transaction. The nonce slot was consumed by a different tx;
 * callers should treat the nonce as lost and resync from chain state.
 */
export class NonceConflictError extends Error {
  override readonly name = "NonceConflictError" as const;
  readonly expectedHash: string;
  readonly nonce: number | null;
  override readonly cause: unknown;

  constructor(expectedHash: string, nonce: number | null, cause: unknown) {
    super(
      `Broadcast for ${expectedHash} (nonce ${nonce ?? "unknown"}) failed; ` +
        "nonce slot was consumed by a different transaction."
    );
    this.expectedHash = expectedHash;
    this.nonce = nonce;
    this.cause = cause;
  }
}

/**
 * A broadcast attempt refused before the request could have reached the
 * node: the tagged, provenance-carrying form of a pre-broadcast network
 * failure.
 *
 * The disposition layer (lib/idempotency-disposition.ts) releases an
 * idempotency key on `broadcastAttempted: false`, so the signal that
 * nothing was sent must not be inferred from message text at a core catch
 * that wraps the whole send-and-confirm try. An ECONNREFUSED surfaced by
 * the post-broadcast receipt poll, or by the nonce bookkeeping insert,
 * reads identically to a refused send while meaning the transaction may
 * already sit in the mempool. The tag is applied here, at the one point
 * where the refusal is known to come from the broadcast call itself; cores
 * test the marker with `isPreBroadcastNetworkError`, never the message.
 */
export class PreBroadcastNetworkError extends Error {
  override readonly name = "PreBroadcastNetworkError" as const;
  readonly kind = "pre-broadcast" as const;
  override readonly cause: unknown;

  constructor(message: string, cause: unknown) {
    super(message);
    this.cause = cause;
  }
}

/**
 * Duck-typed, not `instanceof`: modules that import `server-only` peers can
 * be instantiated in more than one module registry, where the classes are
 * distinct and `instanceof` silently misses. Same discipline as
 * lib/web3/onchain-revert.ts.
 */
export function isPreBroadcastNetworkError(
  error: unknown
): error is PreBroadcastNetworkError {
  return (
    error instanceof Error &&
    (error as PreBroadcastNetworkError).kind === "pre-broadcast"
  );
}

/**
 * Sign once, broadcast with RPC failover, reconcile on error.
 *
 * Wrapping `signer.sendTransaction` in failover is unsafe because ethers
 * re-populates and re-signs on each retry, producing different signed bytes
 * (different gas, possibly stale nonce). This helper signs once so the tx
 * hash is fixed before any retry.
 *
 * On broadcast error, "nonce too low" / "replacement underpriced" cannot be
 * distinguished by message alone: each can mean either "our tx already
 * landed somewhere" or "a competing tx took our nonce." A duplicate-hash
 * reply ("already known") is keyed by hash: the node holds our bytes. We
 * disambiguate by on-chain lookup:
 *   1. getTransactionReceipt(expectedHash) -> if found, tx mined; success.
 *   2. getTransaction(expectedHash)        -> if found, in mempool; success.
 *   3. Neither found AND a duplicate-hash reply, or a nonce conflict while a
 *      copy may have gone out (an extra URL, or an earlier managed attempt
 *      with no clear answer, such as a timeout) -> OnChainPendingError with
 *      the hash. A refused connection is a clear answer: nothing went out.
 *   4. Neither found AND error looks like nonce conflict -> NonceConflictError.
 *   5. Neither found AND other error      -> reconcile by certainty: a
 *      definite pre-broadcast refusal is tagged PreBroadcastNetworkError,
 *      anything else carries the hash as OnChainPendingError, because the
 *      send may have landed.
 *
 * Caller invariants:
 * - txRequest must be fully populated (nonce, chainId, gas, fees). The helper
 *   does not failover during populateTransaction.
 * - `response.wait()` polls on the provider that successfully broadcast;
 *   wait-side failover is a separate concern.
 *
 * The signed bytes determine the hash before broadcast. That fact closes the
 * #1840 ambiguity: a pre-broadcast rejection has no hash, while a send whose
 * reply was lost keeps this deterministic hash and is held/reconciled rather
 * than becoming indistinguishable from "never sent".
 */
export async function submitSignedTransactionWithFailover(
  signer: ethers.Signer,
  txRequest: ethers.TransactionRequest,
  rpcManager: RpcProviderManager,
  report: SendReport = {},
  options: SubmitSignedOptions = {}
): Promise<BroadcastResult> {
  let populated: ethers.TransactionRequest;
  let signedHex: string;
  try {
    populated = await signer.populateTransaction(txRequest);
    signedHex = await signer.signTransaction(populated);
  } catch (error) {
    // No broadcast call has started. Preserve that provenance structurally so
    // callers can release an idempotency key without matching error text.
    throw new PreBroadcastNetworkError(errorMessage(error), error);
  }
  const expectedHash = computeTxHash(signedHex);
  const chainId = Number(ethers.Transaction.from(signedHex).chainId);

  // The manager returns no extra URLs while the private relay is in use.
  const extraUrls = rpcManager.getBroadcastRpcUrls();
  const extras = broadcastToExtraRpcs(
    extraUrls,
    signedHex,
    expectedHash,
    chainId
  );
  // Started before the regular broadcast so neither waits for the other.
  // Never beside a private relay send, whatever the caller passed.
  const builderSends =
    options.builderRpcUrls && !hasRelayPrimary(rpcManager)
      ? broadcastToBuilders(signedHex, expectedHash, options.builderRpcUrls)
      : undefined;
  // Only when another endpoint may take the bytes: started before the send so
  // wait() can spot a replacement on a response we looked up.
  const startBlock =
    extraUrls.length > 0 || builderSends
      ? currentBlockNumber(rpcManager.getProvider())
      : undefined;
  const attempts: Attempt[] = [];
  const routeOf =
    (extraDeliveries: readonly Delivery[]) =>
    (found: boolean): SendRoute | undefined =>
      routeFromEvidence(rpcManager, attempts, extraDeliveries, found);

  try {
    let via: RpcEndpoint = RPC_ENDPOINT.PRIMARY;
    const { response, route, sentAtBlock } =
      await rpcManager.executeWithFailover(async (provider) => {
        via = isFallbackProvider(rpcManager, provider)
          ? RPC_ENDPOINT.FALLBACK
          : RPC_ENDPOINT.PRIMARY;
        const attempt: Attempt = {
          route: rpcManager.isPrivateRelayProvider(provider)
            ? "private-relay"
            : "public",
          delivery: "unknown",
        };
        attempts.push(attempt);
        // Started with the send on the same provider; caught and bounded, so
        // it can never fail the send.
        const blockRead = currentBlockNumber(provider);
        try {
          const sent = await sendRawTransaction(
            provider,
            signedHex,
            expectedHash,
            chainId
          );
          attempt.delivery = "accepted";
          return {
            response: sent,
            route: attempt.route,
            sentAtBlock: blockRead,
          };
        } catch (error) {
          attempt.delivery = deliveryOfBroadcastError(
            error,
            errorMessage(error),
            isDefinitelyPreBroadcastNetworkError(error) ||
              isNonceConflictError(error)
          );
          throw error;
        }
      }, "write-broadcast");
    report.route = route;
    const broadcastAt = new Date().toISOString();
    const builders = builderSends ? await builderSends : undefined;
    return {
      hash: response.hash,
      response: await watchForReplacement(response, sentAtBlock),
      broadcast: { broadcastAt, via, ...(builders ? { builders } : {}) },
    };
  } catch (err) {
    const builders = builderSends ? await builderSends : [];
    const extraTook = await extras.anyAccepted;
    // A builder that answered with our hash holds the bytes in its pool,
    // whatever the RPC said: pending with the hash, never "not sent".
    const builderTook = builders.some((builder) => builder.accepted === true);
    if (extraTook || builderTook) {
      // An extra is public; a builder alone only once a public endpoint may hold it.
      const routeIf = extraTook
        ? (): SendRoute => "public"
        : routeOf(await extras.deliveries);
      try {
        const result = await confirmExtraAccepted(
          rpcManager,
          expectedHash,
          err,
          startBlock
        );
        report.route = routeIf(true);
        return builders.length > 0
          ? { ...result, broadcast: { builders } }
          : result;
      } catch (confirmError) {
        // "Nonce too low" and the nonce now mined by another tx: the builder's copy can never land.
        if (
          !extraTook &&
          isNonceExpiredError(err) &&
          (await nonceMinedElsewhere(
            rpcManager,
            signedHex,
            expectedHash,
            populated.nonce
          ))
        ) {
          throw new NonceConflictError(
            expectedHash,
            typeof populated.nonce === "number" ? populated.nonce : null,
            err
          );
        }
        report.route = routeIf(false);
        throw confirmError;
      }
    }
    const extraDeliveries = await extras.deliveries;
    const routeIf = routeOf(extraDeliveries);
    try {
      const result = await reconcile(
        rpcManager,
        expectedHash,
        populated.nonce,
        err,
        // An extra, or an earlier managed attempt without a clear answer (a
        // timeout or a server error, not a refused connection), may hold our
        // bytes. So may a builder with no clear answer, unless the RPC said
        // the nonce is already used ("replacement underpriced" is not that).
        extraDeliveries.includes("unknown") ||
          attempts.some((attempt) => attempt.delivery === "unknown") ||
          (builders.some((builder) => builder.accepted === null) &&
            !isNonceExpiredError(err))
      );
      report.route = routeIf(true);
      const withBuilders: BroadcastResult =
        builders.length > 0 ? { ...result, broadcast: { builders } } : result;
      // Mined already, or no start block (no extras or builders): nothing to watch for.
      return result.preExistingReceipt || startBlock === undefined
        ? withBuilders
        : {
            ...withBuilders,
            response: await watchForReplacement(result.response, startBlock),
          };
    } catch (reconcileError) {
      if (isOnChainPendingError(reconcileError)) {
        report.route = routeIf(false);
      }
      throw reconcileError;
    }
  }
}

const CONFIRM_LOOKUPS = 3;
const CONFIRM_INTERVAL_MS = 1000;

/**
 * An extra URL or a builder took the bytes but the managed endpoint did
 * not. Success only once the managed endpoint sees the transaction (asked a
 * few times, as gossip takes a moment); otherwise unknown with the hash,
 * never a nonce conflict.
 */
async function confirmExtraAccepted(
  rpcManager: RpcProviderManager,
  expectedHash: string,
  primaryError: unknown,
  startBlock: Promise<number | undefined> | undefined
): Promise<BroadcastResult> {
  let lastError = primaryError;
  for (let lookup = 0; lookup < CONFIRM_LOOKUPS; lookup++) {
    if (lookup > 0) {
      await sleep(CONFIRM_INTERVAL_MS);
    }
    try {
      const seen = await rpcManager.executeWithFailover(
        (provider) => provider.getTransaction(expectedHash),
        "read"
      );
      if (seen) {
        return {
          hash: expectedHash,
          response: await watchForReplacement(seen, startBlock),
        };
      }
    } catch (lookupError) {
      lastError = lookupError;
    }
  }
  throw pendingBroadcast(expectedHash, lastError);
}

// A looked-up response has no start block, so wait() would never check for
// a replacement. Give it one when we have it.
async function watchForReplacement(
  response: ethers.TransactionResponse,
  startBlock: Promise<number | undefined> | undefined
): Promise<ethers.TransactionResponse> {
  const block = await startBlock;
  return block === undefined ||
    typeof response.replaceableTransaction !== "function"
    ? response
    : response.replaceableTransaction(block);
}

const BOUNDED_READ_TIMEOUT_MS = 2000;

// Best effort, bounded: undefined when the read fails or is slow.
async function boundedRead<T>(read: () => Promise<T>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read(),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), BOUNDED_READ_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } catch {
    return;
  } finally {
    clearTimeout(timer);
  }
}

function currentBlockNumber(
  provider: ethers.Provider
): Promise<number | undefined> {
  return boundedRead(() => provider.getBlockNumber());
}

// True only when the sender's mined nonce count is past ours and, asked
// again after that, the network still does not know our hash (best effort).
async function nonceMinedElsewhere(
  rpcManager: RpcProviderManager,
  signedHex: string,
  expectedHash: string,
  nonce: number | null | undefined
): Promise<boolean> {
  const from = ethers.Transaction.from(signedHex).from;
  if (typeof nonce !== "number" || !from) {
    return false;
  }
  const minedCount = await boundedRead(() =>
    rpcManager.executeWithFailover(
      (provider) => provider.getTransactionCount(from, "latest"),
      "read"
    )
  );
  if (!(typeof minedCount === "number" && minedCount > nonce)) {
    return false;
  }
  const ours = await boundedRead(() =>
    rpcManager.executeWithFailover(
      (provider) => provider.getTransaction(expectedHash),
      "read"
    )
  );
  return ours === null;
}

/**
 * The send request alone. ethers' broadcastTransaction also reads the block
 * number at the same time and fails with whichever request fails first, so a
 * refused block read would mark a delivered send as never sent.
 */
async function sendRawTransaction(
  provider: ethers.JsonRpcProvider,
  signedHex: string,
  expectedHash: string,
  chainId: number
): Promise<ethers.TransactionResponse> {
  const hash: unknown = await provider.send("eth_sendRawTransaction", [
    signedHex,
  ]);
  // As ethers checks it: an answer naming another hash is no clear acceptance.
  if (
    typeof hash !== "string" ||
    hash.toLowerCase() !== expectedHash.toLowerCase()
  ) {
    throw new Error(
      `The send was answered with another transaction hash (${String(hash)})`
    );
  }
  return provider._wrapTransactionResponse(
    ethers.Transaction.from(
      signedHex
    ) as unknown as ethers.TransactionResponseParams,
    ethers.Network.from(chainId)
  );
}

// Partial managers (tests) may not expose the relay check.
function hasRelayPrimary(rpcManager: RpcProviderManager): boolean {
  return (
    typeof rpcManager.hasPrivateRelayPrimary === "function" &&
    rpcManager.hasPrivateRelayPrimary()
  );
}

// Partial managers (tests, legacy callers) may not expose the fallback.
function isFallbackProvider(
  rpcManager: RpcProviderManager,
  provider: ethers.JsonRpcProvider
): boolean {
  return (
    typeof rpcManager.getFallbackProvider === "function" &&
    provider === rpcManager.getFallbackProvider()
  );
}

function computeTxHash(signedHex: string): string {
  const tx = ethers.Transaction.from(signedHex);
  if (!tx.hash) {
    throw new Error("Failed to derive transaction hash from signed bytes");
  }
  return tx.hash;
}

async function reconcile(
  rpcManager: RpcProviderManager,
  expectedHash: string,
  nonce: number | null | undefined,
  originalError: unknown,
  mayHaveSent = false
): Promise<BroadcastResult> {
  let receipt: ethers.TransactionReceipt | null;
  let pending: ethers.TransactionResponse | null;
  try {
    receipt = await rpcManager.executeWithFailover(
      (provider) => provider.getTransactionReceipt(expectedHash),
      "read"
    );
    pending = await rpcManager.executeWithFailover(
      (provider) => provider.getTransaction(expectedHash),
      "read"
    );
  } catch (reconcileError) {
    throw pendingBroadcast(expectedHash, reconcileError);
  }

  if (receipt && pending) {
    return {
      hash: expectedHash,
      response: pending,
      preExistingReceipt: receipt,
    };
  }
  if (pending) {
    return { hash: expectedHash, response: pending };
  }
  if (receipt) {
    throw pendingBroadcast(expectedHash, originalError);
  }
  // A copy that may have gone out (extra or earlier attempt) explains "nonce too low" too.
  if (
    isDuplicateMessage(errorMessage(originalError)) ||
    (mayHaveSent && isNonceConflictError(originalError))
  ) {
    throw pendingBroadcast(expectedHash, originalError);
  }
  if (isNonceConflictError(originalError)) {
    throw new NonceConflictError(
      expectedHash,
      typeof nonce === "number" ? nonce : null,
      originalError
    );
  }

  // A refused TCP connection is genuinely pre-broadcast: the peer never
  // accepted a request. Preserve the existing terminal behaviour for that
  // mechanically-known case, tagging it at the point of provenance rather
  // than rethrowing a bare error whose text a downstream catch would have to
  // re-interpret. Timeouts/dropped replies are deliberately NOT in this list
  // because the node may have accepted the signed bytes first.
  if (!mayHaveSent && isDefinitelyPreBroadcastNetworkError(originalError)) {
    throw new PreBroadcastNetworkError(
      errorMessage(originalError),
      originalError
    );
  }

  throw pendingBroadcast(expectedHash, originalError);
}

function pendingBroadcast(
  transactionHash: string,
  cause: unknown
): OnChainPendingError {
  return new OnChainPendingError({
    message: `Transaction send outcome could not be determined (${errorMessage(cause)})`,
    transactionHash,
  });
}

const RPC_FAILOVER_ENDPOINT_SPLIT = /\b(?:primary|fallback):\s*/i;
// ethers' SERVER_ERROR text: an HTTP answer whose body is a gateway's.
const HTTP_ANSWER_TEXT = /code=server_error|server response/;

/**
 * "The broadcast request never left the box": the failover's all-refused flag
 * when present, else every endpoint of our failover summary refused (text).
 * Use only in a catch around the broadcast call alone (reconcile ladder,
 * Tempo send); past it, test the PreBroadcastNetworkError marker instead.
 */
export function isDefinitelyPreBroadcastNetworkError(error: unknown): boolean {
  if (error instanceof Error && "allAttemptsConnectionRefused" in error) {
    const aggregate = (
      error as Error & { allAttemptsConnectionRefused?: unknown }
    ).allAttemptsConnectionRefused;
    if (typeof aggregate === "boolean") {
      return aggregate;
    }
  }

  const message = errorMessage(error).toLowerCase();
  const endpointFailures = message
    .split(RPC_FAILOVER_ENDPOINT_SPLIT)
    .slice(1)
    .map((part) => part.trim())
    .filter(Boolean);

  // Our failover summary: every endpoint must have refused, and an HTTP
  // answer never counts.
  if (endpointFailures.length > 0) {
    return endpointFailures.every(
      (part) => !HTTP_ANSWER_TEXT.test(part) && isConnectionRefusal(part)
    );
  }
  return isConnectionRefusal(error);
}

// "Nonce too low": the nonce is used in a mined block (a replacement answer is not that).
const NONCE_EXPIRED_MESSAGE_PATTERNS: readonly string[] = [
  "nonce too low",
  "nonce is too low",
  "nonce has already been used",
];

function isNonceExpiredError(err: unknown): boolean {
  if (isError(err, "NONCE_EXPIRED")) {
    return true;
  }
  const msg = errorMessage(err).toLowerCase();
  return NONCE_EXPIRED_MESSAGE_PATTERNS.some((pattern) =>
    msg.includes(pattern)
  );
}

/**
 * Recognise nonce-conflict errors across two layers:
 *
 * 1. Direct EthersError thrown from broadcastTransaction. ethers v6 translates
 *    raw node messages to typed codes in provider-jsonrpc.ts :: getRpcError:
 *      - "nonce too low" / "transaction nonce is too low" -> NONCE_EXPIRED
 *      - "replacement transaction underpriced"            -> REPLACEMENT_UNDERPRICED
 *    These are matched by code via isError(...).
 *
 * 2. Wrapped Error thrown by rpcManager.executeWithFailover when both
 *    endpoints fail. It re-throws a plain Error with the inner error
 *    messages interpolated as text, dropping the typed code. We fall back
 *    to substring matching on the message for those cases.
 *
 * The substring list covers BOTH raw node phrasings AND the canonical text
 * ethers picks when it constructs the typed error (e.g. "nonce has already
 * been used" is ethers' NONCE_EXPIRED message, distinct from the raw node
 * "nonce too low"). Duplicate-hash replies ("already known") are not here:
 * they name our own hash, never another transaction's nonce.
 */
const NONCE_CONFLICT_MESSAGE_PATTERNS: readonly string[] = [
  ...NONCE_EXPIRED_MESSAGE_PATTERNS,
  "replacement transaction underpriced",
  "replacement underpriced",
  "replacement fee too low",
];

export function isNonceConflictError(err: unknown): boolean {
  if (isError(err, "NONCE_EXPIRED")) {
    return true;
  }
  if (isError(err, "REPLACEMENT_UNDERPRICED")) {
    return true;
  }
  const msg = errorMessage(err).toLowerCase();
  return NONCE_CONFLICT_MESSAGE_PATTERNS.some((pattern) =>
    msg.includes(pattern)
  );
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  return String(err);
}
