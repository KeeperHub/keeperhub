import "server-only";
import type { ethers } from "ethers";
import { neverReached } from "@/lib/rpc/connection-refusal";
import { safeFetch } from "@/lib/safe-fetch";
import { readCappedBody } from "@/lib/web3/capped-body";
import {
  classifyRpcError,
  type Delivery,
  type JsonRpcError,
  parseJsonRpcAnswer,
} from "@/lib/web3/json-rpc-answer";
import { flashbotsSignature } from "./signature";

const REQUEST_TIMEOUT_MS = 2000;
const MAX_RESPONSE_BYTES = 16 * 1024;
const MAX_ERROR_LENGTH = 160;
const HTTP_REQUEST_TIMEOUT = 408;
const BUNDLE_HASH_RE = /^0x[0-9a-f]{64}$/i;
// An ANSI escape sequence, so no "[31m" is left once the ESC is gone.
const ANSI_ESCAPE_RE = /\p{Cc}\[[0-9;?]*[A-Za-z]/gu;
const CONTROL_OR_FORMAT_RE = /[\p{Cc}\p{Cf}]/gu;
const SPACE_RE = /\s/u;
const URL_RE = /https?:\/\/\S+/gi;
// Longer than a 32-byte hash: signed transactions, calldata.
const LONG_HEX_RE = /0x[0-9a-f]{65,}/gi;
// Raw hex with no 0x (an echoed RLP, say), not the tail of a 0x run.
const RAW_HEX_RE = /(?<![0-9a-f]|0x)[0-9a-f]{64,}/gi;
const WHITESPACE_RE = /\s+/g;

type BundleBuilderEndpoint = { name: string; url: string };

/** One builder's answer to one bundle. */
export type BuilderAnswer = {
  builder: string;
  delivery: Delivery;
  /** Only a well-formed 32-byte hash is kept, in lowercase. */
  bundleHash?: string;
  /** Scrubbed and capped; never a URL, long hex or control character. */
  error?: string;
};

type Outcome = Omit<BuilderAnswer, "builder">;

/**
 * Send one bundle to every builder in parallel. A builder's failure never
 * throws: each outcome is in its answer.
 */
export async function sendBundle(options: {
  builders: readonly BundleBuilderEndpoint[];
  signedTxs: readonly string[];
  targetBlock: number;
  searcher: ethers.Signer;
  timeoutMs?: number;
  // Unix seconds: builders that honour it never include the bundle in an earlier block.
  minTimestamp?: number;
}): Promise<BuilderAnswer[]> {
  const body = bundleRequestBody(
    options.signedTxs,
    options.targetBlock,
    options.minTimestamp
  );
  const signature = await flashbotsSignature(options.searcher, body);
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  return await Promise.all(
    options.builders.map(async (builder) => ({
      builder: builder.name,
      ...(await postBundle(builder.url, body, signature, timeoutMs)),
    }))
  );
}

// Built once and sent as the same bytes to every builder, so one signature
// covers them all.
function bundleRequestBody(
  signedTxs: readonly string[],
  targetBlock: number,
  minTimestamp: number | undefined
): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "eth_sendBundle",
    params: [
      {
        txs: [...signedTxs],
        blockNumber: `0x${targetBlock.toString(16)}`,
        revertingTxHashes: [],
        ...(minTimestamp !== undefined && { minTimestamp }),
      },
    ],
  });
}

async function postBundle(
  url: string,
  body: string,
  signature: string,
  timeoutMs: number
): Promise<Outcome> {
  let response: Response;
  try {
    response = await safeFetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-flashbots-signature": signature,
      },
      body,
      // Never re-send the signed body to wherever a redirect points.
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      plugin: "bundle-builder",
    });
  } catch (error) {
    // No redirect is followed, so an unresolved or blocked host never got the body.
    return neverReached(error)
      ? { delivery: "refused", error: "connection failed" }
      : { delivery: "unknown", error: "no answer in time" };
  }
  const early = outcomeOfStatus(response);
  if (early) {
    await response.body?.cancel().catch(() => undefined);
    return early;
  }
  const text = await readCappedBody(response, MAX_RESPONSE_BYTES);
  return readBuilderAnswer(response.status, text);
}

// Statuses whose body is not worth reading.
function outcomeOfStatus(response: Response): Outcome | undefined {
  const { status } = response;
  if (status >= 500 || status === HTTP_REQUEST_TIMEOUT) {
    return { delivery: "unknown", error: `HTTP ${status}` };
  }
  // The host read the whole POST, signed bytes included: it may have sent.
  if (response.type === "opaqueredirect" || (status >= 300 && status < 400)) {
    return { delivery: "unknown", error: "redirect not followed" };
  }
  return;
}

/**
 * Strict reading of a 2xx or 4xx answer (`text` undefined when the body was
 * too large or cut off). Only an object result or a bundle hash counts as
 * accepted; null and anything else is unknown, since some builders answer
 * null to anything.
 */
function readBuilderAnswer(status: number, text: string | undefined): Outcome {
  const parsed = text === undefined ? undefined : parseJsonRpcAnswer(text);
  // A valid bundle hash beside an error wins, as beside a falsy one:
  // accepted holds the nonce, the safe reading of a contradiction.
  const answeredHash = normalizedHash(
    isAcceptedObject(parsed?.result) ? parsed.result.bundleHash : parsed?.result
  );
  if (parsed?.error && answeredHash) {
    return { delivery: "accepted", bundleHash: answeredHash };
  }
  if (parsed?.error) {
    return {
      delivery: classifyRpcError(parsed.error),
      error: rpcErrorText(parsed.error, status),
    };
  }
  // A 4xx with no JSON-RPC error may come from a CDN, WAF or moved host that
  // read the whole POST, signed bytes included: it may have sent.
  if (status >= 400) {
    return { delivery: "unknown", error: `HTTP ${status}` };
  }
  if (status < 200 || status >= 300 || parsed === undefined) {
    return { delivery: "unknown", error: "unreadable answer" };
  }
  const { result } = parsed;
  if (result === undefined || result === null) {
    return { delivery: "unknown", error: "no result" };
  }
  if (typeof result === "string") {
    const hash = normalizedHash(result);
    return hash
      ? { delivery: "accepted", bundleHash: hash }
      : { delivery: "unknown", error: "unexpected result" };
  }
  if (!isAcceptedObject(result)) {
    return { delivery: "unknown", error: "unexpected result" };
  }
  const hash = normalizedHash(result.bundleHash);
  return hash
    ? { delivery: "accepted", bundleHash: hash }
    : { delivery: "accepted" };
}

function isAcceptedObject(result: unknown): result is { bundleHash?: unknown } {
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return false;
  }
  // An error tucked inside the result is not an acceptance.
  const inner = (result as { error?: unknown }).error;
  return inner === undefined || inner === null;
}

function normalizedHash(value: unknown): string | undefined {
  return typeof value === "string" && BUNDLE_HASH_RE.test(value)
    ? `0x${value.slice(2).toLowerCase()}`
    : undefined;
}

function rpcErrorText(error: JsonRpcError, status: number): string {
  const message = typeof error.message === "string" ? error.message : "";
  const scrubbed = scrubBuilderError(message);
  return scrubbed === "" ? `HTTP ${status}` : scrubbed;
}

// Builder text as it may be shown: no controls, URLs or long hex, capped.
function scrubBuilderError(message: string): string {
  const cleaned = message
    .replace(ANSI_ESCAPE_RE, "")
    .replace(CONTROL_OR_FORMAT_RE, (char) => (SPACE_RE.test(char) ? " " : ""))
    .replace(URL_RE, "[redacted]")
    .replace(LONG_HEX_RE, "[redacted]")
    .replace(RAW_HEX_RE, "[redacted]")
    .replace(WHITESPACE_RE, " ")
    .trim();
  // By code point, so a surrogate pair is never split.
  const chars = Array.from(cleaned);
  return chars.length > MAX_ERROR_LENGTH
    ? `${chars
        .slice(0, MAX_ERROR_LENGTH - 3)
        .join("")
        .trimEnd()}...`
    : cleaned;
}
