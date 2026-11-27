import "server-only";
import { logWarn } from "@/lib/logging";
import type { BuilderRpcUrls } from "@/lib/rpc/rpc-config";
import { redactAllUrls } from "@/lib/rpc/scrub-rpc-urls";
import { safeFetch } from "@/lib/safe-fetch";
import { getErrorMessage } from "@/lib/utils";

const BUILDER_BROADCAST_TIMEOUT_MS = 2000;

const MAX_ERROR_LENGTH = 200;
const JSON_RPC_VERSION = "2.0";
const SEND_RAW_TRANSACTION = "eth_sendRawTransaction";
const SAFE_FETCH_LABEL = "builder-broadcast";

export type BuilderBroadcastResult = {
  name: string;
  accepted: boolean;
  error?: string;
};

type JsonRpcReply = {
  result?: unknown;
  error?: { message?: unknown };
};

// A builder that already holds the transaction counts as accepted.
const ALREADY_KNOWN = /already known|known transaction/i;

// Builder replies end up in the step output, so URLs are removed first.
function cleanError(message: string): string {
  const redacted = redactAllUrls(message);
  return redacted.length > MAX_ERROR_LENGTH
    ? `${redacted.slice(0, MAX_ERROR_LENGTH)}...`
    : redacted;
}

async function sendToBuilder(
  name: string,
  url: string,
  signedHex: string
): Promise<BuilderBroadcastResult> {
  try {
    const response = await safeFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: JSON_RPC_VERSION,
        id: 1,
        method: SEND_RAW_TRANSACTION,
        params: [signedHex],
      }),
      signal: AbortSignal.timeout(BUILDER_BROADCAST_TIMEOUT_MS),
      plugin: SAFE_FETCH_LABEL,
    });
    const reply = (await response.json()) as JsonRpcReply;
    if (typeof reply.result === "string") {
      return { name, accepted: true };
    }
    const message =
      typeof reply.error?.message === "string"
        ? reply.error.message
        : `HTTP ${response.status}`;
    if (ALREADY_KNOWN.test(message)) {
      return { name, accepted: true };
    }
    return { name, accepted: false, error: cleanError(message) };
  } catch (error) {
    return { name, accepted: false, error: cleanError(getErrorMessage(error)) };
  }
}

// Best-effort parallel send: failures are reported by label, never thrown.
export async function broadcastToBuilders(
  signedHex: string,
  builders: BuilderRpcUrls
): Promise<BuilderBroadcastResult[]> {
  const results = await Promise.all(
    Object.entries(builders).map(([name, url]) =>
      sendToBuilder(name, url, signedHex)
    )
  );
  for (const result of results) {
    if (!result.accepted) {
      logWarn(`[BuilderBroadcast] ${result.name} did not accept transaction`, {
        builder: result.name,
        error: result.error ?? "",
      });
    }
  }
  return results;
}
