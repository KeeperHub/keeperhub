import "server-only";
import { logWarn } from "@/lib/logging";
import { neverReached } from "@/lib/rpc/connection-refusal";
import type { BuilderRpcUrls } from "@/lib/rpc/rpc-config";
import { redactAllUrls } from "@/lib/rpc/scrub-rpc-urls";
import { safeFetch } from "@/lib/safe-fetch";
import { getErrorMessage } from "@/lib/utils";
import { readCappedBody } from "@/lib/web3/capped-body";
import {
  classifyRpcError,
  parseJsonRpcAnswer,
} from "@/lib/web3/json-rpc-answer";

const BUILDER_BROADCAST_TIMEOUT_MS = 2000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const HTTP_REQUEST_TIMEOUT = 408;

const MAX_ERROR_LENGTH = 200;
const JSON_RPC_VERSION = "2.0";
const SEND_RAW_TRANSACTION = "eth_sendRawTransaction";
const SAFE_FETCH_LABEL = "builder-broadcast";

export type BuilderBroadcastResult = {
  name: string;
  // true: it answered with our hash (or already had it); false: it turned the
  // transaction down or was never reached; null: no clear answer.
  accepted: boolean | null;
  error?: string;
};

// Builder replies end up in the step output, so URLs are removed first.
function cleanError(message: string): string {
  const redacted = redactAllUrls(message);
  return redacted.length > MAX_ERROR_LENGTH
    ? `${redacted.slice(0, MAX_ERROR_LENGTH)}...`
    : redacted;
}

function normalizeHash(value: string): string {
  const trimmed = value.trim().toLowerCase();
  return trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
}

async function sendToBuilder(
  name: string,
  url: string,
  signedHex: string,
  expectedHash: string
): Promise<BuilderBroadcastResult> {
  let response: Response;
  try {
    response = await safeFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: JSON_RPC_VERSION,
        id: 1,
        method: SEND_RAW_TRANSACTION,
        params: [signedHex],
      }),
      signal: AbortSignal.timeout(BUILDER_BROADCAST_TIMEOUT_MS),
      // Never re-send the signed bytes to wherever a redirect points.
      redirect: "manual",
      plugin: SAFE_FETCH_LABEL,
    });
  } catch (error) {
    // No redirect is followed, so a host never reached never got the bytes.
    return {
      name,
      accepted: neverReached(error) ? false : null,
      error: cleanError(getErrorMessage(error)),
    };
  }
  const status = response.status;
  if (
    (status >= 300 && status < 400) ||
    status >= 500 ||
    status === HTTP_REQUEST_TIMEOUT
  ) {
    // It read the request, signed bytes included: no clear answer.
    await response.body?.cancel().catch(() => undefined);
    return {
      name,
      accepted: null,
      error: status < 400 ? "redirect not followed" : `HTTP ${status}`,
    };
  }
  const body = await readCappedBody(response, MAX_RESPONSE_BYTES);
  const answer = body === undefined ? undefined : parseJsonRpcAnswer(body);
  if (typeof answer?.result === "string") {
    // Anything but our hash (a tracking id, say) proves nothing either way.
    return normalizeHash(answer.result) === normalizeHash(expectedHash)
      ? { name, accepted: true }
      : { name, accepted: null, error: "answered with another hash" };
  }
  if (answer?.error) {
    const delivery = classifyRpcError(answer.error);
    if (delivery === "accepted") {
      return { name, accepted: true };
    }
    const message =
      typeof answer.error.message === "string"
        ? answer.error.message
        : `HTTP ${status}`;
    return {
      name,
      accepted: delivery === "refused" ? false : null,
      error: cleanError(message),
    };
  }
  // Some 4xx carry no JSON-RPC answer: still a refusal.
  return status >= 400
    ? { name, accepted: false, error: `HTTP ${status}` }
    : { name, accepted: null, error: "unreadable answer" };
}

// Best-effort parallel send: failures are reported by label, never thrown.
export async function broadcastToBuilders(
  signedHex: string,
  expectedHash: string,
  builders: BuilderRpcUrls
): Promise<BuilderBroadcastResult[]> {
  const results = await Promise.all(
    Object.entries(builders).map(([name, url]) =>
      sendToBuilder(name, url, signedHex, expectedHash).catch(
        (error: unknown): BuilderBroadcastResult => ({
          name,
          accepted: null,
          error: cleanError(getErrorMessage(error)),
        })
      )
    )
  );
  for (const result of results) {
    if (result.accepted !== true) {
      logWarn(`[BuilderBroadcast] ${result.name} did not accept transaction`, {
        builder: result.name,
        error: result.error ?? "",
      });
    }
  }
  return results;
}
