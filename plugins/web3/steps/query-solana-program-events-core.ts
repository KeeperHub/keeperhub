import "server-only";
import { sleep } from "@/lib/sleep";
import { getRpcPreferenceUserId } from "@/lib/workflow/executor/helpers";

import type {
  ConfirmedSignatureInfo,
  VersionedTransactionResponse,
} from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { getSolanaProvider } from "@/lib/rpc/provider-factory";
import type { SolanaProviderManager } from "@/lib/rpc/providers/solana";
import { getErrorMessage } from "@/lib/utils";
import {
  applyReadFailOnError,
  type ReadDestinationFailure,
  type ReadFailOnErrorInput,
} from "./read-fail-on-error-core";
import {
  type AnchorEventDecoder,
  createEventDecoder,
} from "@/lib/web3/anchor-events";

// Solana has no `eth_getLogs` equivalent: `getSignaturesForAddress` only
// takes `before`/`until` signature cursors (not a slot range) and returns no
// log data, so every signature in the window needs a follow-up
// `getTransaction` call to see its logs. These caps bound a single
// invocation's RPC cost and wall-clock time; hitting them surfaces as
// `truncated: true` with a cursor to continue, never a silent drop.
export const MAX_SIGNATURE_PAGES = 10;
export const MAX_SIGNATURES_PER_PAGE = 1000;
export const DEFAULT_SIGNATURE_LOOKBACK = 1000;
export const MAX_SIGNATURE_LOOKBACK =
  MAX_SIGNATURE_PAGES * MAX_SIGNATURES_PER_PAGE;
export const MAX_TRANSACTION_CONCURRENCY = 8;
export const NULL_TX_RETRY_ATTEMPTS = 3;
export const NULL_TX_RETRY_DELAY_MS = 1000;

const INTEGER_STRING_RE = /^\d+$/;
const BASE58_SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;

export type QuerySolanaProgramEventsCoreInput = ReadFailOnErrorInput & {
  network: string;
  programId: string;
  idl?: string;
  eventName?: string;
  signatureLookback?: number | string;
  beforeSignature?: string;
  untilSignature?: string;
  _context?: {
    executionId?: string;
  };
};

export type SolanaProgramEvent = {
  signature: string;
  slot: number;
  blockTime: number | null;
  eventName?: string;
  args?: Record<string, unknown>;
  raw?: string[];
};

export type QuerySolanaProgramEventsResult =
  | {
      success: true;
      // Null when failOnError=false softened a failed query into a success
      // value so the workflow continues; `error` carries the reason. Null
      // rather than an empty list so a downstream node cannot read a failed
      // query as "no events in range".
      events: SolanaProgramEvent[] | null;
      oldestSignature: string | null;
      newestSignature: string | null;
      signatureCount: number | null;
      eventCount: number | null;
      truncated: boolean | null;
      nextBeforeSignature: string | null;
      failedSignatureCount: number | null;
      otherEventNamesSeen: string[] | null;
      error?: string;
    }
  | (ReadDestinationFailure & { success: false; error: string });

/** Data fields a softened query reports, so a soft failure never looks like an empty result set. */
const SOFT_QUERY_FIELDS = {
  events: null,
  oldestSignature: null,
  newestSignature: null,
  signatureCount: null,
  eventCount: null,
  truncated: null,
  nextBeforeSignature: null,
  failedSignatureCount: null,
  otherEventNamesSeen: null,
} as const;

function parseSignatureLookback(
  input: number | string | undefined
): { success: true; value: number } | { success: false; error: string } {
  if (input === undefined || input === null || input === "") {
    return { success: true, value: DEFAULT_SIGNATURE_LOOKBACK };
  }

  let parsed: number;
  if (typeof input === "number") {
    if (!Number.isInteger(input) || input <= 0) {
      return {
        success: false,
        error: `Invalid signatureLookback value: ${input}`,
      };
    }
    parsed = input;
  } else {
    // Node config is untyped JSON at runtime - a boolean/array/object here
    // must fail as invalid input, not throw on .trim().
    if (typeof input !== "string") {
      return {
        success: false,
        error: `Invalid signatureLookback value: ${String(input)}`,
      };
    }
    const trimmed = input.trim();
    if (!INTEGER_STRING_RE.test(trimmed)) {
      return {
        success: false,
        error: `Invalid signatureLookback value: ${input}`,
      };
    }
    parsed = Number.parseInt(trimmed, 10);
    // The regex only admits digit strings, so the remaining invalid case is
    // "0" - reject it like the number branch rejects 0.
    if (parsed <= 0) {
      return {
        success: false,
        error: `Invalid signatureLookback value: ${input}`,
      };
    }
  }

  return { success: true, value: Math.min(parsed, MAX_SIGNATURE_LOOKBACK) };
}

function validateSignatureCursor(
  value: string | undefined,
  label: string
): { success: true } | { success: false; error: string } {
  if (value === undefined || value === "") {
    return { success: true };
  }
  if (!BASE58_SIGNATURE_RE.test(value)) {
    return {
      success: false,
      error: `Invalid ${label}: not a well-formed transaction signature`,
    };
  }
  return { success: true };
}

type ResolvedQuery = {
  programKey: PublicKey;
  decoder: AnchorEventDecoder | null;
  lookback: number;
  chainId: number;
};

function resolveQueryContext(
  input: QuerySolanaProgramEventsCoreInput
):
  | { success: true; value: ResolvedQuery }
  | (ReadDestinationFailure & { success: false; error: string }) {
  let programKey: PublicKey;
  try {
    programKey = new PublicKey(input.programId);
  } catch {
    return {
      success: false,
      destinationError: true,
      error: `Invalid program ID: ${input.programId}`,
    };
  }

  const beforeCheck = validateSignatureCursor(
    input.beforeSignature,
    "beforeSignature"
  );
  if (!beforeCheck.success) {
    return { success: false, error: beforeCheck.error };
  }
  const untilCheck = validateSignatureCursor(
    input.untilSignature,
    "untilSignature"
  );
  if (!untilCheck.success) {
    return { success: false, error: untilCheck.error };
  }

  // createEventDecoder degrades to raw-log mode (returns null) on a missing
  // or unusable IDL rather than throwing - a deliberate divergence from
  // call-solana-program-anchor's hard-error IDL handling, since that action
  // signs and spends (a bad IDL must block it) while this one only reads (a
  // bad IDL degrading to raw output is safe). See lib/web3/anchor-events.ts.
  const decoder = createEventDecoder(input.idl, input.programId);
  if (input.eventName && !decoder) {
    return {
      success: false,
      error:
        "eventName filtering requires a valid Anchor IDL in the idl field",
    };
  }

  const lookbackResult = parseSignatureLookback(input.signatureLookback);
  if (!lookbackResult.success) {
    return { success: false, error: lookbackResult.error };
  }

  let chainId: number;
  try {
    chainId = getChainIdFromNetwork(input.network);
  } catch (error) {
    return {
      success: false,
      destinationError: true,
      error: getErrorMessage(error),
    };
  }

  return {
    success: true,
    value: { programKey, decoder, lookback: lookbackResult.value, chainId },
  };
}

async function fetchSignaturePage(
  rpcManager: SolanaProviderManager,
  programKey: PublicKey,
  options: { before?: string; until?: string; limit: number }
): Promise<ConfirmedSignatureInfo[]> {
  // executeWithFailover already retries against primary then fallback, each
  // with its own backoff - an extra retry loop here would only re-run that
  // same budget several times over without giving a transient failure a
  // better chance to clear.
  return rpcManager.executeWithFailover((connection) =>
    connection.getSignaturesForAddress(programKey, options)
  );
}

/**
 * Pages `getSignaturesForAddress` backward from `beforeSignature` (or the
 * newest signature, if unset) down to `untilSignature` (or the page/limit
 * caps), collecting up to `limit` signatures newest-first.
 */
async function collectSignatures(
  rpcManager: SolanaProviderManager,
  programKey: PublicKey,
  beforeSignature: string | undefined,
  untilSignature: string | undefined,
  limit: number
): Promise<{ signatures: ConfirmedSignatureInfo[]; truncated: boolean }> {
  const collected: ConfirmedSignatureInfo[] = [];
  let before = beforeSignature;
  let hitCap = false;

  for (let page = 0; page < MAX_SIGNATURE_PAGES; page++) {
    const remaining = limit - collected.length;
    if (remaining <= 0) {
      hitCap = true;
      break;
    }
    const pageLimit = Math.min(remaining, MAX_SIGNATURES_PER_PAGE);

    let batch: ConfirmedSignatureInfo[];
    try {
      batch = await fetchSignaturePage(rpcManager, programKey, {
        before,
        until: untilSignature,
        limit: pageLimit,
      });
    } catch (error) {
      if (collected.length === 0) {
        // Nothing salvageable from this scan; surface a real error rather
        // than an empty success.
        throw error;
      }
      // Keep the signatures already collected from earlier pages instead of
      // discarding a partially-successful scan - the caller can resume from
      // this boundary via nextBeforeSignature.
      return { signatures: collected, truncated: true };
    }

    collected.push(...batch);
    if (batch.length < pageLimit) {
      // Fewer results than requested: no more history behind this cursor.
      break;
    }
    before = batch.at(-1)?.signature;
    if (page === MAX_SIGNATURE_PAGES - 1) {
      hitCap = true;
    }
  }

  return { signatures: collected, truncated: hitCap && collected.length > 0 };
}

type TransactionFetchResult =
  | { kind: "ok"; tx: VersionedTransactionResponse }
  | { kind: "failed" };

/**
 * getTransaction can return null for a signature getSignaturesForAddress
 * already returned, most often because it has not finished indexing yet.
 * That is a successful call with no data, distinct from a thrown RPC error
 * (which executeWithFailover already retries against both endpoints
 * internally) - so this only adds a short retry for the null case, rather
 * than layering another retry on top of executeWithFailover's own.
 */
async function fetchTransactionWithRetry(
  rpcManager: SolanaProviderManager,
  signature: string
): Promise<TransactionFetchResult> {
  for (let attempt = 1; attempt <= NULL_TX_RETRY_ATTEMPTS; attempt++) {
    let tx: VersionedTransactionResponse | null;
    try {
      tx = await rpcManager.executeWithFailover((connection) =>
        connection.getTransaction(signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        })
      );
    } catch {
      return { kind: "failed" };
    }
    if (tx) {
      return { kind: "ok", tx };
    }
    if (attempt < NULL_TX_RETRY_ATTEMPTS) {
      await sleep(NULL_TX_RETRY_DELAY_MS * attempt);
    }
  }
  return { kind: "failed" };
}

type SignatureFetchResult = {
  events: SolanaProgramEvent[];
  failed: boolean;
  unmatchedEventNames: string[];
};

async function fetchAndDecodeSignature(
  rpcManager: SolanaProviderManager,
  info: ConfirmedSignatureInfo,
  decoder: AnchorEventDecoder | null,
  eventName: string | undefined
): Promise<SignatureFetchResult> {
  if (info.err) {
    // A failed instruction's events are not committed state; skip it,
    // matching the live event trigger's SignaturesSource behavior.
    return { events: [], failed: false, unmatchedEventNames: [] };
  }

  const fetched = await fetchTransactionWithRetry(rpcManager, info.signature);
  if (fetched.kind === "failed") {
    // Distinct from "zero events found": the transaction could not be
    // fetched at all, so its true event count is unknown. Reported via
    // failedSignatureCount rather than silently folded into a zero-event
    // result.
    return { events: [], failed: true, unmatchedEventNames: [] };
  }

  const logs = fetched.tx.meta?.logMessages ?? [];

  if (!decoder) {
    return {
      events: [
        {
          signature: info.signature,
          slot: info.slot,
          blockTime: info.blockTime ?? null,
          raw: logs,
        },
      ],
      failed: false,
      unmatchedEventNames: [],
    };
  }

  const decoded = decoder.decodeLogs(logs);
  const matched = eventName
    ? decoded.filter((event) => event.name === eventName)
    : decoded;
  const unmatchedEventNames = eventName
    ? decoded
        .filter((event) => event.name !== eventName)
        .map((event) => event.name)
    : [];

  return {
    events: matched.map((event) => ({
      signature: info.signature,
      slot: info.slot,
      blockTime: info.blockTime ?? null,
      eventName: event.name,
      args: event.data,
    })),
    failed: false,
    unmatchedEventNames,
  };
}

/**
 * Runs `worker` over `items` with at most `concurrency` in flight at once,
 * each freed slot immediately pulling the next item - unlike a fixed-chunk
 * barrier, one slow item never stalls otherwise-idle slots.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  const runWorker = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, runWorker)
  );

  return results;
}

export async function queryProgramEventsCore(
  input: QuerySolanaProgramEventsCoreInput
): Promise<QuerySolanaProgramEventsResult> {
  return applyReadFailOnError(
    await queryProgramEventsInner(input),
    input.failOnError,
    SOFT_QUERY_FIELDS
  );
}

async function queryProgramEventsInner(
  input: QuerySolanaProgramEventsCoreInput
): Promise<QuerySolanaProgramEventsResult> {
  const resolved = resolveQueryContext(input);
  if (!resolved.success) {
    return resolved;
  }
  const { programKey, decoder, lookback, chainId } = resolved.value;
  const eventName = input.eventName;

  const userId = await getRpcPreferenceUserId(input._context?.executionId);

  let rpcManager: SolanaProviderManager;
  try {
    rpcManager = await getSolanaProvider({ chainId, userId });
  } catch (error) {
    return {
      success: false,
      destinationError: true,
      error: getErrorMessage(error),
    };
  }

  let signatures: ConfirmedSignatureInfo[];
  let truncated: boolean;
  try {
    const page = await collectSignatures(
      rpcManager,
      programKey,
      input.beforeSignature,
      input.untilSignature,
      lookback
    );
    signatures = page.signatures;
    truncated = page.truncated;
  } catch (error) {
    const message = `Signature lookup failed: ${getErrorMessage(error)}`;
    return { success: false, error: message };
  }

  if (signatures.length === 0) {
    return {
      success: true,
      events: [],
      oldestSignature: null,
      newestSignature: null,
      signatureCount: 0,
      eventCount: 0,
      truncated: false,
      nextBeforeSignature: null,
      failedSignatureCount: 0,
      otherEventNamesSeen: [],
    };
  }

  // Newest-first from the RPC; process oldest-first so events in the output
  // are ordered the same way they occurred on-chain.
  const oldestFirst = [...signatures].reverse();

  const perSignature = await mapWithConcurrency(
    oldestFirst,
    MAX_TRANSACTION_CONCURRENCY,
    (info) => fetchAndDecodeSignature(rpcManager, info, decoder, eventName)
  );

  const events = perSignature.flatMap((result) => result.events);
  const failedSignatureCount = perSignature.filter(
    (result) => result.failed
  ).length;
  const otherEventNamesSeen = [
    ...new Set(perSignature.flatMap((result) => result.unmatchedEventNames)),
  ].sort();

  return {
    success: true,
    events,
    oldestSignature: oldestFirst[0].signature,
    newestSignature: oldestFirst.at(-1)?.signature ?? null,
    signatureCount: signatures.length,
    eventCount: events.length,
    truncated,
    nextBeforeSignature: truncated ? oldestFirst[0].signature : null,
    failedSignatureCount,
    otherEventNamesSeen,
  };
}
