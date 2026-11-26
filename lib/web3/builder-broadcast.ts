import "server-only";
import { logWarn } from "@/lib/logging";
import type { BuilderRpcUrls } from "@/lib/rpc/rpc-config";
import { redactAllUrls } from "@/lib/rpc/scrub-rpc-urls";
import { safeFetch } from "@/lib/safe-fetch";
import { getErrorMessage } from "@/lib/utils";

export const BUILDER_BROADCAST_TIMEOUT_MS = 2000;

const MAX_ERROR_LENGTH = 200;

export type BuilderBroadcastResult = {
  name: string;
  accepted: boolean;
  error?: string;
};

type JsonRpcReply = {
  result?: unknown;
  error?: { message?: unknown };
};

// A builder that already holds the transaction has it, which is the goal.
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
        jsonrpc: "2.0",
        id: 1,
        method: "eth_sendRawTransaction",
        params: [signedHex],
      }),
      signal: AbortSignal.timeout(BUILDER_BROADCAST_TIMEOUT_MS),
      plugin: "builder-broadcast",
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

/**
 * Send already-signed bytes to block builders, in parallel. Best-effort: a
 * builder that rejects or times out is reported, never thrown, so it cannot
 * fail a transaction the regular RPC accepted. Results carry the label only,
 * never the URL.
 */
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
