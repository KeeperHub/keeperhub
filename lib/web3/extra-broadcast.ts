import "server-only";
import { logWarn } from "@/lib/logging";
import { neverReached } from "@/lib/rpc/connection-refusal";
import { safeFetch } from "@/lib/safe-fetch";
import { readCappedBody } from "@/lib/web3/capped-body";
import {
  classifyRpcError,
  type Delivery,
  parseJsonRpcAnswer,
} from "@/lib/web3/json-rpc-answer";

type ExtraBroadcast = {
  /** True as soon as one extra URL accepts; false once all have answered. */
  anyAccepted: Promise<boolean>;
  /** Every extra URL's delivery, bounded by the request timeout. */
  deliveries: Promise<Delivery[]>;
};

const EXTRA_BROADCAST_TIMEOUT_MS = 5000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const HTTP_REQUEST_TIMEOUT = 408;

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
    // It read the request, signed bytes included: may have sent, like a managed 3xx.
    await response.body?.cancel().catch(() => undefined);
    return { delivery: "unknown", kind: "http_3xx" };
  }
  if (response.status >= 500) {
    await response.body?.cancel().catch(() => undefined);
    return { delivery: "unknown", kind: "http_5xx" };
  }
  if (response.status === HTTP_REQUEST_TIMEOUT) {
    await response.body?.cancel().catch(() => undefined);
    return { delivery: "unknown", kind: "http_408" };
  }
  const body = await readCappedBody(response, MAX_RESPONSE_BYTES);
  const answer =
    body === undefined ? undefined : readAnswer(body, expectedHash);
  if (response.status >= 400) {
    // A JSON-RPC error ("already known") inside a 4xx is read; a bare 4xx may
    // come from a CDN or WAF that read the signed bytes: it may have sent.
    return answer ?? { delivery: "unknown", kind: "http_4xx" };
  }
  return answer ?? { delivery: "unknown", kind: "bad_response" };
}

// The JSON-RPC answer in a body; undefined when the body is not one.
function readAnswer(
  body: string,
  expectedHash: string
): SendOutcome | undefined {
  const parsed = parseJsonRpcAnswer(body);
  if (typeof parsed?.result === "string") {
    // Anything but our hash (a tracking id, say) may still have been forwarded.
    return normalizeHash(parsed.result) === normalizeHash(expectedHash)
      ? { delivery: "accepted", kind: "accepted" }
      : { delivery: "unknown", kind: "unexpected_hash" };
  }
  if (parsed?.error) {
    return { delivery: classifyRpcError(parsed.error), kind: "rpc_error" };
  }
  return;
}

function normalizeHash(value: string): string {
  const trimmed = value.trim().toLowerCase();
  return trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
}

/**
 * Whether an extra URL's node knows this transaction (eth_getTransactionByHash):
 * true when it returns it, false on a clear null, undefined when unclear.
 */
export async function extraRpcHasTransaction(
  url: string,
  hash: string
): Promise<boolean | undefined> {
  try {
    const response = await safeFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getTransactionByHash",
        params: [hash],
      }),
      signal: AbortSignal.timeout(EXTRA_BROADCAST_TIMEOUT_MS),
      redirect: "manual",
      plugin: "rpc-evm",
    });
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      return;
    }
    const body = await readCappedBody(response, MAX_RESPONSE_BYTES);
    const parsed = body === undefined ? undefined : parseJsonRpcAnswer(body);
    if (!parsed || parsed.error || parsed.result === undefined) {
      return;
    }
    return parsed.result !== null;
  } catch {
    return;
  }
}
