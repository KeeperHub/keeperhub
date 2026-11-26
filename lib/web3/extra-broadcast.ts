import "server-only";
import { logWarn } from "@/lib/logging";
import { neverReached } from "@/lib/rpc/connection-refusal";
import { safeFetch } from "@/lib/safe-fetch";

/**
 * What one endpoint did with our signed bytes: took them (or already had
 * them), answered and turned them down, or left it unknown.
 */
export type Delivery = "accepted" | "refused" | "unknown";

type ExtraBroadcast = {
  /** True as soon as one extra URL accepts; false once all have answered. */
  anyAccepted: Promise<boolean>;
  /** Every extra URL's delivery, bounded by the request timeout. */
  deliveries: Promise<Delivery[]>;
};

const EXTRA_BROADCAST_TIMEOUT_MS = 5000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const JSON_RPC_INTERNAL_ERROR = -32_603;
const HTTP_REQUEST_TIMEOUT = 408;
const UNKNOWN_OUTCOME_PATTERN =
  /internal error|timed out|timeout|deadline exceeded/i;

// Node replies that mean "I already hold a transaction with this hash"
// (geth, Erigon, Nethermind's "AlreadyKnown", Parity's "already imported").
// Whole words only, so "unknown transaction type" is not a duplicate.
const DUPLICATE_HASH_PATTERN =
  /\balready known\b|\balreadyknown\b|\balready imported\b|\bknown transaction\b/i;

export function isDuplicateHashMessage(message: string): boolean {
  return DUPLICATE_HASH_PATTERN.test(message);
}

/** How a JSON-RPC error answer to eth_sendRawTransaction reads. */
export function deliveryOfRpcError(rpcError: {
  code?: unknown;
  message?: unknown;
}): Delivery {
  const message = typeof rpcError.message === "string" ? rpcError.message : "";
  if (isDuplicateHashMessage(message)) {
    return "accepted";
  }
  // An internal error or a gateway timeout can follow a forward, so it
  // proves nothing either way.
  if (
    rpcError.code === JSON_RPC_INTERNAL_ERROR ||
    UNKNOWN_OUTCOME_PATTERN.test(message)
  ) {
    return "unknown";
  }
  return "refused";
}

/**
 * Send the signed bytes to every extra URL at once. Never rejects; each
 * request is aborted after EXTRA_BROADCAST_TIMEOUT_MS. Logs carry only the
 * chain id and an error kind, never a URL or a message.
 */
export function broadcastToExtraRpcs(
  urls: readonly string[],
  signedHex: string,
  expectedHash: string,
  chainId: number
): ExtraBroadcast {
  const sends = urls.map((url) =>
    sendRaw(url, signedHex, expectedHash)
      .catch((): SendOutcome => ({ delivery: "unknown", kind: "internal" }))
      .then(({ delivery, kind }) => {
        if (delivery !== "accepted") {
          logWarn("[Broadcast] An extra RPC did not take the transaction", {
            chain_id: String(chainId),
            error_type: kind,
          });
        }
        return delivery;
      })
  );
  const anyAccepted = new Promise<boolean>((resolve) => {
    for (const send of sends) {
      send.then((delivery) => delivery === "accepted" && resolve(true));
    }
    Promise.all(sends).then(() => resolve(false));
  });
  return { anyAccepted, deliveries: Promise.all(sends) };
}

type SendOutcome = { delivery: Delivery; kind: string };

async function sendRaw(
  url: string,
  signedHex: string,
  expectedHash: string
): Promise<SendOutcome> {
  let response: Response;
  try {
    response = await safeFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_sendRawTransaction",
        params: [signedHex],
      }),
      signal: AbortSignal.timeout(EXTRA_BROADCAST_TIMEOUT_MS),
      // Never re-send the signed bytes to wherever a redirect points.
      redirect: "manual",
      plugin: "rpc-evm",
    });
  } catch (error) {
    // No redirect is followed, so an unresolved or blocked host never got the bytes.
    const reason = neverReached(error);
    if (reason) {
      return {
        delivery: "refused",
        kind: reason === "refused" ? "connection_refused" : "unreachable",
      };
    }
    return { delivery: "unknown", kind: "network" };
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined);
    return { delivery: "refused", kind: "http_3xx" };
  }
  if (response.status >= 500) {
    await response.body?.cancel().catch(() => undefined);
    return { delivery: "unknown", kind: "http_5xx" };
  }
  if (response.status === HTTP_REQUEST_TIMEOUT) {
    await response.body?.cancel().catch(() => undefined);
    return { delivery: "unknown", kind: "http_408" };
  }
  const body = await readCapped(response);
  const answer =
    body === undefined ? undefined : readAnswer(body, expectedHash);
  if (response.status >= 400) {
    // Some nodes answer a JSON-RPC error ("already known") inside a 4xx.
    return answer ?? { delivery: "refused", kind: "http_4xx" };
  }
  return answer ?? { delivery: "unknown", kind: "bad_response" };
}

// The JSON-RPC answer in a body; undefined when the body is not one.
function readAnswer(
  body: string,
  expectedHash: string
): SendOutcome | undefined {
  let parsed: {
    result?: unknown;
    error?: { code?: unknown; message?: unknown };
  };
  try {
    parsed = JSON.parse(body);
  } catch {
    return;
  }
  if (typeof parsed?.result === "string") {
    // Anything but our hash (a tracking id, say) may still have been forwarded.
    return normalizeHash(parsed.result) === normalizeHash(expectedHash)
      ? { delivery: "accepted", kind: "accepted" }
      : { delivery: "unknown", kind: "unexpected_hash" };
  }
  if (parsed?.error && typeof parsed.error === "object") {
    return { delivery: deliveryOfRpcError(parsed.error), kind: "rpc_error" };
  }
  return;
}

function normalizeHash(value: string): string {
  const trimmed = value.trim().toLowerCase();
  return trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
}

// Reads at most MAX_RESPONSE_BYTES; undefined when larger or cut off.
async function readCapped(response: Response): Promise<string | undefined> {
  const reader = response.body?.getReader();
  if (!reader) {
    return "";
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return;
      }
      chunks.push(value);
    }
  } catch {
    return;
  }
  return Buffer.concat(chunks).toString("utf8");
}
