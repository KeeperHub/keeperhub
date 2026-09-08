/**
 * @security Internal service-to-service authentication.
 *
 * HMAC scheme. Producer signs the request with a shared secret stored
 * encrypted-at-rest in internal_service_hmac_secrets. Headers:
 *      X-KH-Caller     identity claim (one of InternalCaller)
 *      X-KH-Timestamp  unix seconds, validated within +/- 300 s
 *      X-KH-Signature  64-char lowercase hex
 *      X-KH-Key-Version (optional) pins secret selection to a specific row
 *
 * Signing string format (caller bound into the signed bytes so a forged
 * header cannot route to another caller's audit row):
 *      signingString = `${method}\n${pathname}\n${caller}\n${sha256_hex(body)}\n${timestamp}`
 *      signature     = hex(hmac_sha256(secret, signingString))
 *
 * Replay within the 300-second window is INTENTIONALLY accepted. Matches
 * the agentic-wallet HMAC precedent: a server-side nonce cache is
 * defense-in-depth with measurable latency cost; the upstream attack model
 * (env-var leak detected via audit log) is closed faster by short rotation
 * than by single-use enforcement. Revisit if a future review requires it.
 *
 * For v1 every producer shares one signing secret stored at
 * caller = SHARED_SECRET_KEY. A future per-caller split is a single
 * INSERT plus per-client env update; the verifier path needs no change
 * beyond replacing the constant with `claimedCaller`.
 *
 * Never log secret material, signatures, or timestamps in error paths.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  listActiveHmacSecrets,
  lookupHmacSecret,
} from "@/lib/internal-service-hmac-store";
import { logInternalAuthEvent } from "@/lib/logging";

export type InternalCaller =
  | "executor"
  | "scheduler"
  | "events"
  | "mcp"
  | "hub";

const INTERNAL_CALLERS: ReadonlySet<InternalCaller> = new Set([
  "executor",
  "scheduler",
  "events",
  "mcp",
  "hub",
]);

/**
 * Sentinel caller key under which the single shared signing secret is stored
 * in v1. Distinct from any InternalCaller value so a future per-caller split
 * (one row per producer) does not collide with this row.
 */
const SHARED_SECRET_KEY = "*shared*";

const REPLAY_WINDOW_SECONDS = 300;
const SIGNATURE_HEX_LENGTH = 64;

export type InternalServiceAuthResult =
  | {
      authenticated: true;
      caller: InternalCaller;
      scheme: "hmac";
      keyVersion?: number;
    }
  | { authenticated: false; error: string; status: number };

/**
 * Authenticate an internal service request.
 *
 * Pass `rawBody` for any method that carries a body. For GET requests pass
 * undefined or the empty string. The verifier hashes `rawBody` directly; it
 * does NOT read request.body itself, so the body-already-consumed footgun
 * stays inside the route handler where it is visible.
 */
export async function authenticateInternalService(
  request: Request,
  rawBody?: string
): Promise<InternalServiceAuthResult> {
  const startedAt = Date.now();
  const result = await runAuthentication(request, rawBody);
  emitAuditEvent(request, result, Date.now() - startedAt);
  return result;
}

async function runAuthentication(
  request: Request,
  rawBody?: string
): Promise<InternalServiceAuthResult> {
  const hasHmac =
    request.headers.get("X-KH-Signature") !== null ||
    request.headers.get("X-KH-Caller") !== null ||
    request.headers.get("X-KH-Timestamp") !== null;

  if (hasHmac) {
    return await verifyHmac(request, rawBody ?? "");
  }

  return {
    authenticated: false,
    error: "Missing auth headers",
    status: 401,
  };
}

function emitAuditEvent(
  request: Request,
  result: InternalServiceAuthResult,
  latencyMs: number
): void {
  const url = new URL(request.url);
  const ip =
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for") ??
    null;

  if (result.authenticated) {
    logInternalAuthEvent({
      outcome: "accept",
      scheme: result.scheme,
      caller: result.caller,
      route: url.pathname,
      method: request.method,
      ip,
      keyVersion: result.keyVersion,
      latencyMs,
    });
    return;
  }

  const claimed = request.headers.get("X-KH-Caller");
  // Sanitize the caller label so a malicious header cannot inflate the
  // log/metric cardinality with arbitrary strings.
  const caller =
    claimed !== null && INTERNAL_CALLERS.has(claimed as InternalCaller)
      ? claimed
      : "unknown";
  logInternalAuthEvent({
    outcome: "reject",
    scheme: pickAttemptedScheme(request),
    caller,
    route: url.pathname,
    method: request.method,
    ip,
    reason: result.error,
    latencyMs,
  });
}

function pickAttemptedScheme(request: Request): "hmac" | "none" {
  if (
    request.headers.get("X-KH-Signature") !== null ||
    request.headers.get("X-KH-Caller") !== null ||
    request.headers.get("X-KH-Timestamp") !== null
  ) {
    return "hmac";
  }
  return "none";
}

function computeSignature(
  secret: string,
  method: string,
  path: string,
  caller: string,
  body: string,
  timestamp: string
): string {
  const bodyDigest = createHash("sha256").update(body).digest("hex");
  const signingString = `${method}\n${path}\n${caller}\n${bodyDigest}\n${timestamp}`;
  return createHmac("sha256", secret).update(signingString).digest("hex");
}

async function verifyHmac(
  request: Request,
  rawBody: string
): Promise<InternalServiceAuthResult> {
  const caller = request.headers.get("X-KH-Caller");
  const timestamp = request.headers.get("X-KH-Timestamp");
  const signature = request.headers.get("X-KH-Signature");

  if (!(caller && timestamp && signature)) {
    return {
      authenticated: false,
      error: "Missing HMAC headers",
      status: 401,
    };
  }

  if (!INTERNAL_CALLERS.has(caller as InternalCaller)) {
    return {
      authenticated: false,
      error: "Unknown caller",
      status: 401,
    };
  }

  const now = Math.floor(Date.now() / 1000);
  const ts = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > REPLAY_WINDOW_SECONDS) {
    return {
      authenticated: false,
      error: "Timestamp outside replay window",
      status: 401,
    };
  }

  // Length pre-check before the DB lookup. A sha256-hex signature is always 64
  // chars; any other length is garbage and we can reject it without touching
  // the DB. Length is not secret so the non-constant compare is safe.
  if (signature.length !== SIGNATURE_HEX_LENGTH) {
    return {
      authenticated: false,
      error: "Invalid signature",
      status: 401,
    };
  }

  const versionHeader = request.headers.get("X-KH-Key-Version");
  let pinnedVersion: number | undefined;
  if (versionHeader !== null) {
    const v = Number.parseInt(versionHeader, 10);
    if (!Number.isInteger(v) || v <= 0 || String(v) !== versionHeader.trim()) {
      return {
        authenticated: false,
        error: "Invalid key version",
        status: 401,
      };
    }
    pinnedVersion = v;
  }

  // v1: every producer shares one signing secret stored under
  // SHARED_SECRET_KEY. Future per-caller split replaces this constant
  // with `caller` so the secret lookup tracks producer identity.
  const secretKey = SHARED_SECRET_KEY;

  // Without a pinned version, try every active secret (newest first, then any
  // still-within-grace older versions) so the 24-hour rotation window
  // actually lets in-flight consumers verify against the previous secret
  // while they pick up the new one. With a pinned version, only that row is tried.
  const candidates =
    pinnedVersion === undefined
      ? await listActiveHmacSecrets(secretKey)
      : await (async (): Promise<{ secret: string; keyVersion: number }[]> => {
          const single = await lookupHmacSecret(secretKey, pinnedVersion);
          return single ? [single] : [];
        })();

  if (candidates.length === 0) {
    return {
      authenticated: false,
      error: "No active signing secret",
      status: 401,
    };
  }

  const url = new URL(request.url);
  const providedSigBuf = Buffer.from(signature, "hex");

  for (const candidate of candidates) {
    const expected = computeSignature(
      candidate.secret,
      request.method,
      url.pathname,
      caller,
      rawBody,
      timestamp
    );
    const expectedBuf = Buffer.from(expected, "hex");
    if (
      providedSigBuf.length === expectedBuf.length &&
      timingSafeEqual(providedSigBuf, expectedBuf)
    ) {
      return {
        authenticated: true,
        caller: caller as InternalCaller,
        scheme: "hmac",
        keyVersion: candidate.keyVersion,
      };
    }
  }

  return {
    authenticated: false,
    error: "Invalid signature",
    status: 401,
  };
}
