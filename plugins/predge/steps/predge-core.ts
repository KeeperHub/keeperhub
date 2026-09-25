import "server-only";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";

import { ErrorCategory, logUserError } from "@/lib/logging";
import {
  assertUrlIsPublic,
  safeFetch,
  SsrfBlockedError,
} from "@/lib/safe-fetch";
import { getErrorMessage } from "@/lib/utils";
import { stripTrailingSlashes } from "@/lib/utils/url";
import type { PredgeCredentials } from "../credentials";

// Predge serves verifiable smart-money signals. Each signal arrives as a
// detached ed25519 attestation over a canonical encoding of the payload, so a
// workflow can confirm the number was issued by Predge and was not altered in
// flight -- with no call back to Predge and no trust in the transport. The
// signed read is a free, unauthenticated GET; the point of this plugin is the
// verification, which a Code node cannot do (its sandbox exposes `crypto` as
// `{ randomUUID }` only, with no `subtle`).
//
// Default hosted signal service. Point PREDGE_SIGNAL_URL at your own Predge
// deployment (or a local dev service) to override.
const DEFAULT_PREDGE_SIGNAL_URL = "https://api.predge.io";

// The signature scheme Predge stamps on every attestation.
const PREDGE_SCHEME = "veri402-ed25519-v1";

// Predge's published attestation signing key (hex raw ed25519 public key, role
// "attestation" in https://api.predge.io/.well-known/predge-keys.json). A
// detached attestation only means something against a signer known in advance,
// so this is pinned by default and verification fails closed against it.
// Override with PREDGE_SIGNER_KEY_ID to pin a different deployment's key.
const DEFAULT_PINNED_SIGNER =
  "13fa3d18a369e6c71bf941563ba47822b30182273d5106a0e8fb61c5016352d9";

// A freshly issued attestation is re-minted per request, so a short window
// kills replay of a captured older response without breaking legitimate reads.
const DEFAULT_MAX_SIGNAL_AGE_SECONDS = 600;
// Tolerate a little clock skew on issuedAt before calling it future-dated.
const MAX_CLOCK_SKEW_MS = 60_000;
// A signal host that accepts the connection and never answers must not hold the
// step open. Mirrors plugins/robinhood/steps/stock-token-core.ts.
const FETCH_TIMEOUT_MS = 10_000;
// The signed envelope is well under a kilobyte, and the host is operator-chosen,
// so bound what a misconfigured or hostile one can make the step parse.
//
// It bounds what is parsed, not what is allocated, with the same caveat
// plugins/web3/steps/check-approval-exploit.ts states: the declared
// content-length is checked first and is the allocation bound for any server
// that states one, but when the header is absent `response.text()` has already
// materialised the whole body before its length can be read, so the second
// check is too late to bound memory. `body.length` also counts UTF-16 code
// units rather than bytes, which for the ASCII JSON this endpoint serves is the
// same number and for anything else is a smaller one than the budget names.
const MAX_RESPONSE_BYTES = 64 * 1024;

// Opening words of the reason a resource mismatch fails with. The step matches
// on this to attribute the failure, so the constant is the contract between the
// two and the message can be reworded without silently changing attribution.
export const RESOURCE_MISMATCH_REASON = "attestation is for";

// Domain separator for the conviction-signal product: the `resource` the signal
// service stamps, and the thing this plugin is willing to read. `scheme` is a
// constant any issuer can copy and `payload.wallet` only says which wallet, so
// without this the only thing separating a conviction signal from some other
// attestation the same key signed about the same wallet is the field names in
// the payload. `resource` is covered by the signature, so comparing it is what
// makes the binding.
const RESOURCE_PREFIX = "conviction:";

// The complete set of values the signal service emits for the two categorical
// fields. Anything else is rejected rather than passed through, so a workflow
// branching on them can enumerate them and know the list is exhaustive.
export const PREDGE_ACTIONS = ["accumulate", "reduce", "hold"] as const;
export const PREDGE_WINDOWS = ["7d", "30d"] as const;

export type PredgeAction = (typeof PREDGE_ACTIONS)[number];
export type PredgeWindow = (typeof PREDGE_WINDOWS)[number];

// Conviction is a percentile within Predge's ranked smart-money set, so it is a
// number in this closed range -- never a numeric string, never out of range.
export const MIN_CONVICTION = 0;
export const MAX_CONVICTION = 100;

export type PredgeConvictionSignal = {
  wallet: string;
  // 0-100 conviction from Predge's on-chain track-record model.
  conviction: number;
  // What an executor should do with the wallet.
  action: PredgeAction;
  window: PredgeWindow;
};

type PredgeAttestation = {
  scheme: string;
  // Which signed product this envelope is; `conviction:<wallet>` here. Signed,
  // and checked against the expected value -- see RESOURCE_PREFIX.
  resource: string;
  // Shape-checked by parseConvictionPayload, not by this type: the body is
  // untrusted JSON, so the declared type is a claim until that runs.
  payload: PredgeConvictionSignal;
  issuedAt: string;
  nonce: string;
  // hex ed25519 public key that signed this attestation.
  keyId: string;
};

export type PredgeSignedAttestation = {
  attestation: PredgeAttestation;
  // hex detached ed25519 signature over canonicalize(attestation).
  signature: string;
};

export type PredgeFetchResult<T> =
  | { success: true; data: T }
  | { success: false; error: string; errorClass?: ExecutionErrorType };

export type PredgeVerifyInput = {
  // The wallet the step asked for. The signed payload must be about this exact
  // wallet, otherwise a correctly signed signal about a different wallet passes.
  requestedWallet: string;
  // Signer to trust. Falls back to Predge's published key; never to the key the
  // response carries.
  expectedKeyId?: string;
  // Reject an attestation older than this many seconds. Falls back to 600.
  maxAgeSeconds?: number;
  // Injectable clock for tests.
  now?: number;
};

export type PredgeVerifyResult = {
  // True only when scheme, pinned signer, signature, subject, the signed
  // `resource` and freshness all hold. Internal to this module: the step does not return it. A workflow that
  // reads a boolean can forget to branch on it, so the step fails instead, and
  // an unverified signal cannot be stepped over by omission.
  verified: boolean;
  // Why verification failed, for surfacing to the operator. Undefined on pass.
  reason?: string;
  // hex ed25519 public key the attestation claims to be signed by.
  signer: string;
  // True only when payload.wallet matches the requested wallet AND the
  // signature has already held. Every failure path reports false, including
  // paths that never compared the wallets, so the field cannot assert a binding
  // the signature has not earned. False means "not established", not
  // "mismatch".
  subjectMatch: boolean;
  // ISO-8601 issue time carried by the attestation, when present.
  issuedAt?: string;
  // Age of the attestation in seconds at verification time, when computable.
  ageSeconds?: number;
};

// Deterministic JSON: object keys sorted recursively, so signer and verifier
// hash the exact same bytes regardless of key order. Mirrors Predge's signer.
// Exported so tests can produce the exact bytes the verifier checks.
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`)
    .join(",")}}`;
}

// Returns an ArrayBuffer-backed view (not ArrayBufferLike) so it satisfies
// WebCrypto's BufferSource parameters without a cast.
function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) {
    throw new Error("invalid hex");
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// EVM addresses are case-insensitive, so compare them normalized.
function normalizeWallet(wallet: string): string {
  const trimmed = wallet.trim().toLowerCase();
  return trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
}

async function ed25519SignatureValid(
  attestation: PredgeAttestation,
  signature: string
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      hexToBytes(attestation.keyId),
      { name: "Ed25519" },
      false,
      ["verify"]
    );
    const message = new TextEncoder().encode(canonicalize(attestation));
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      hexToBytes(signature),
      message
    );
  } catch {
    return false;
  }
}

/**
 * Offline verification of a Predge signal via WebCrypto -- no external
 * dependency and no call back to Predge. Returns a structured result rather
 * than throwing, so a bad signal is a clean `verified: false` with a reason.
 *
 * `verified` is true only when every one of these holds, checked in order:
 *   1. the scheme is the one Predge stamps;
 *   2. the attestation is signed by the pinned signer (the response never gets
 *      to choose its own key);
 *   3. the ed25519 signature matches the canonical payload bytes;
 *   4. the payload is about the wallet the step asked for;
 *   5. the signed `resource` is the conviction signal for that same wallet,
 *      not another signed Predge product about it;
 *   6. the attestation was issued recently enough.
 */
export async function verifyPredgeSignal(
  signed: PredgeSignedAttestation,
  input: PredgeVerifyInput
): Promise<PredgeVerifyResult> {
  const attestation = signed?.attestation as PredgeAttestation | undefined;
  const signature = signed?.signature;

  // Malformed guard first, before any field is read, and type-check the exact
  // fields the checks below call string methods on. A hostile or self-hosted
  // response (`200 {}`, `{"wallet": 123}`, a numeric keyId) then returns a
  // clean `verified: false` instead of throwing out of the step. Read the
  // untrusted body through an `unknown` view so the checks are real at runtime.
  const raw = attestation as unknown as {
    scheme?: unknown;
    resource?: unknown;
    keyId?: unknown;
    issuedAt?: unknown;
    payload?: { wallet?: unknown };
  } | undefined;
  if (
    !raw ||
    typeof signature !== "string" ||
    typeof raw.scheme !== "string" ||
    typeof raw.resource !== "string" ||
    typeof raw.keyId !== "string" ||
    typeof raw.payload?.wallet !== "string"
  ) {
    return {
      verified: false,
      reason: "malformed attestation",
      signer: typeof raw?.keyId === "string" ? raw.keyId : "",
      subjectMatch: false,
    };
  }

  const signer = raw.keyId;
  const walletInPayload = raw.payload.wallet;
  const issuedAt = typeof raw.issuedAt === "string" ? raw.issuedAt : undefined;
  const pinned = (input.expectedKeyId?.trim() || DEFAULT_PINNED_SIGNER).toLowerCase();

  // subjectMatch is reported true only after scheme, signer and signature have
  // held, so the field never claims a binding the signature has not earned.
  const fail = (reason: string, ageSeconds?: number): PredgeVerifyResult => ({
    verified: false,
    reason,
    signer,
    subjectMatch: false,
    issuedAt,
    ageSeconds,
  });

  if (raw.scheme !== PREDGE_SCHEME) {
    return fail(`unexpected scheme ${JSON.stringify(raw.scheme)}`);
  }
  if (signer.toLowerCase() !== pinned) {
    // The finding that matters: without this, the responder chooses both the
    // key and the signature over it, and `verified` means nothing.
    return fail("signer is not the pinned Predge key");
  }
  if (!(await ed25519SignatureValid(attestation as PredgeAttestation, signature))) {
    return fail("signature does not match payload");
  }

  // Subject binding, checked only now that the signature holds.
  const requestedWallet = normalizeWallet(input.requestedWallet);
  const subjectMatch = normalizeWallet(walletInPayload) === requestedWallet;
  if (!subjectMatch) {
    return fail("signal is about a different wallet");
  }

  // Domain separation, on the same signed bytes: this envelope has to be the
  // conviction signal for this wallet, not another signed product about it.
  const expectedResource = `${RESOURCE_PREFIX}${requestedWallet}`;
  if (raw.resource.trim().toLowerCase() !== expectedResource) {
    return fail(
      `${RESOURCE_MISMATCH_REASON} ${JSON.stringify(raw.resource)}, expected ${JSON.stringify(expectedResource)}`
    );
  }

  const issuedMs = issuedAt ? Date.parse(issuedAt) : Number.NaN;
  if (Number.isNaN(issuedMs)) {
    return fail("missing or unparseable issuedAt");
  }
  const now = input.now ?? Date.now();
  const ageMs = now - issuedMs;
  const ageSeconds = Math.round(ageMs / 1000);
  const maxAgeSeconds = input.maxAgeSeconds ?? DEFAULT_MAX_SIGNAL_AGE_SECONDS;
  if (ageMs > maxAgeSeconds * 1000) {
    return fail(`attestation is stale (${ageSeconds}s old)`, ageSeconds);
  }
  if (ageMs < -MAX_CLOCK_SKEW_MS) {
    return fail("attestation issuedAt is in the future", ageSeconds);
  }

  return { verified: true, signer, subjectMatch: true, issuedAt, ageSeconds };
}

export type PredgePayloadResult =
  | { valid: true; signal: PredgeConvictionSignal }
  | { valid: false; reason: string };

// What a value actually is, for an error the operator can act on: the runtime
// type, and the value itself when it is short enough to be worth printing.
function describeValue(value: unknown): string {
  if (value === undefined) {
    return "missing";
  }
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  const type = typeof value;
  if (type === "object" || type === "function") {
    return type;
  }
  const rendered = JSON.stringify(value) ?? String(value);
  return rendered.length > 40 ? type : `${type} ${rendered}`;
}

/**
 * Check that a verified payload is the shape the step claims to return, and
 * return it typed. A signature proves who issued the bytes and that they did
 * not change; it says nothing about what is in them, so every field the step
 * exposes is checked here before it reaches a workflow.
 *
 * Nothing is coerced. `conviction: "99999"` is a failure, not the number 99999:
 * a template comparison would read `"99999" >= 80` as true, on a value the
 * documented 0-100 range does not admit. A missing field is a failure too --
 * emitting the key as `undefined` renders empty in a template and silently
 * skips a `conviction < 30` branch, which is the wrong way for a gate to fail.
 */
export function parseConvictionPayload(payload: unknown): PredgePayloadResult {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return {
      valid: false,
      reason: `payload must be an object, got ${describeValue(payload)}`,
    };
  }
  const raw = payload as Record<string, unknown>;

  if (typeof raw.wallet !== "string" || raw.wallet.trim() === "") {
    return {
      valid: false,
      reason: `wallet must be a non-empty string, got ${describeValue(raw.wallet)}`,
    };
  }

  const conviction = raw.conviction;
  if (typeof conviction !== "number" || !Number.isFinite(conviction)) {
    return {
      valid: false,
      reason: `conviction must be a finite number in ${MIN_CONVICTION}-${MAX_CONVICTION}, got ${describeValue(conviction)}`,
    };
  }
  if (conviction < MIN_CONVICTION || conviction > MAX_CONVICTION) {
    return {
      valid: false,
      reason: `conviction must be in ${MIN_CONVICTION}-${MAX_CONVICTION}, got number ${conviction}`,
    };
  }

  if (!(PREDGE_ACTIONS as readonly unknown[]).includes(raw.action)) {
    return {
      valid: false,
      reason: `action must be one of ${PREDGE_ACTIONS.join(", ")}, got ${describeValue(raw.action)}`,
    };
  }
  if (!(PREDGE_WINDOWS as readonly unknown[]).includes(raw.window)) {
    return {
      valid: false,
      reason: `window must be one of ${PREDGE_WINDOWS.join(", ")}, got ${describeValue(raw.window)}`,
    };
  }

  return {
    valid: true,
    signal: {
      wallet: raw.wallet,
      conviction,
      action: raw.action as PredgeAction,
      window: raw.window as PredgeWindow,
    },
  };
}

/**
 * Who a bad response body is attributed to. It is the upstream's doing unless
 * the operator repointed the host, in which case they are reading something
 * that was never a Predge response. Covers an unparseable body, an oversized
 * one, a malformed attestation, an envelope signed for a different resource and
 * a payload that is not a conviction signal, which are the same mistake at five
 * depths. Attribution only: this changes no
 * retry behaviour, only which side of the fence the run is filed on.
 */
export function blameForBadBody(credentials: PredgeCredentials): ExecutionErrorType {
  return credentials.PREDGE_SIGNAL_URL?.trim()
    ? ExecutionErrorType.USER
    : ExecutionErrorType.EXTERNAL;
}

function isParseableUrl(value: string): boolean {
  try {
    return Boolean(new URL(value));
  } catch {
    return false;
  }
}

function resolveBaseUrl(credentials: PredgeCredentials): string {
  const override = credentials.PREDGE_SIGNAL_URL?.trim();
  const base = override && override.length > 0 ? override : DEFAULT_PREDGE_SIGNAL_URL;
  return stripTrailingSlashes(base);
}

/**
 * Fetch a signed Predge signal for a wallet. Read-only GET through safeFetch so
 * the SSRF guard attributes every request; the base URL is user-configurable so
 * it is validated with `assertUrlIsPublic` first (always-on, ignores shadow
 * mode). Carries an explicit timeout so a stalled host cannot hold the step.
 */
export async function fetchSignedSignal(
  wallet: string,
  credentials: PredgeCredentials
): Promise<PredgeFetchResult<PredgeSignedAttestation>> {
  const base = resolveBaseUrl(credentials);
  const url = `${base}/v1/signal/${encodeURIComponent(wallet)}`;

  // A base URL the operator typed can be unparseable ("api.predge.io" with no
  // scheme, say). assertUrlIsPublic throws a plain TypeError on that, which
  // would otherwise be reported as Predge being unreachable rather than as the
  // typo it is.
  if (!isParseableUrl(url)) {
    return {
      success: false,
      error: `Predge signal URL is not a valid URL: ${url}`,
      errorClass: ExecutionErrorType.USER,
    };
  }

  try {
    await assertUrlIsPublic(url);

    const response = await safeFetch(url, {
      plugin: "predge",
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      if (response.status === 404) {
        return {
          success: false,
          error: "No Predge signal for this wallet.",
          errorClass: ExecutionErrorType.USER,
        };
      }
      if (response.status === 402) {
        // The signed-signal read is meant to be free. A 402 means this endpoint
        // is gated and the plugin is not the right tool to pay for it.
        return {
          success: false,
          error:
            "Predge signal endpoint requires payment; this plugin reads the free signed-signal endpoint only.",
          errorClass: ExecutionErrorType.USER,
        };
      }
      if (response.status === 429) {
        // Rate limiting from the signal host is transient and is not the
        // workflow author's configuration, so it does not belong in their error
        // budget. plugins/discord/steps/send-message.ts and
        // plugins/pagerduty/steps/pagerduty-core.ts both treat 429 this way.
        return {
          success: false,
          error: "Predge signal service is rate limiting this caller (HTTP 429).",
          errorClass: ExecutionErrorType.EXTERNAL,
        };
      }
      return {
        success: false,
        error: `HTTP ${response.status}: ${response.statusText}`,
        errorClass:
          response.status >= 500
            ? ExecutionErrorType.EXTERNAL
            : ExecutionErrorType.USER,
      };
    }

    // Declared size first, so an oversized body is refused before it becomes a
    // string; a missing or unparseable header reads as NaN and falls through to
    // the length check below, which is the real bound on what gets parsed.
    const declaredBytes = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredBytes) && declaredBytes > MAX_RESPONSE_BYTES) {
      return {
        success: false,
        error: `Predge response declared ${declaredBytes} bytes, over the ${MAX_RESPONSE_BYTES} byte limit.`,
        errorClass: blameForBadBody(credentials),
      };
    }
    const body = await response.text();
    if (body.length > MAX_RESPONSE_BYTES) {
      return {
        success: false,
        error: `Predge response exceeded the ${MAX_RESPONSE_BYTES} byte limit.`,
        errorClass: blameForBadBody(credentials),
      };
    }

    try {
      return { success: true, data: JSON.parse(body) as PredgeSignedAttestation };
    } catch {
      return {
        success: false,
        error: "Predge response was not valid JSON.",
        errorClass: blameForBadBody(credentials),
      };
    }
  } catch (error) {
    if (error instanceof SsrfBlockedError) {
      logUserError(
        ErrorCategory.VALIDATION,
        "[Predge] Blocked SSRF target",
        error.message,
        { plugin_name: "predge" }
      );
      return {
        success: false,
        error: `Predge signal URL is not allowed: ${error.message}`,
        errorClass: ExecutionErrorType.USER,
      };
    }
    return {
      success: false,
      error: `Failed to reach Predge: ${getErrorMessage(error)}`,
      errorClass: ExecutionErrorType.EXTERNAL,
    };
  }
}
