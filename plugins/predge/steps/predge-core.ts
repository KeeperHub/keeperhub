import "server-only";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";

import { ErrorCategory, logUserError } from "@/lib/logging";
import {
  assertUrlIsPublic,
  safeFetch,
  SsrfBlockedError,
} from "@/lib/safe-fetch";
import { getErrorMessage } from "@/lib/utils";
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
const TRAILING_SLASH_RE = /\/+$/;

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

export type PredgeConvictionSignal = {
  wallet: string;
  // 0-100 conviction from Predge's on-chain track-record model.
  conviction: number;
  // What an executor should do with the wallet.
  action: "accumulate" | "reduce" | "hold";
  window: "7d" | "30d";
  source?: string;
};

type PredgeAttestation = {
  scheme: string;
  resource: string;
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
  // True only when scheme, pinned signer, signature, subject and freshness all
  // hold. This is the field a workflow gates value movement on.
  verified: boolean;
  // Why verification failed, for surfacing to the operator. Undefined on pass.
  reason?: string;
  // hex ed25519 public key the attestation claims to be signed by.
  signer: string;
  // Whether payload.wallet matches the requested wallet.
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

function hexToBytes(hex: string): Uint8Array {
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
 *   5. the attestation was issued recently enough.
 */
export async function verifyPredgeSignal(
  signed: PredgeSignedAttestation,
  input: PredgeVerifyInput
): Promise<PredgeVerifyResult> {
  const attestation = signed?.attestation;
  const signature = signed?.signature;
  const signer = attestation?.keyId ?? "";
  const issuedAt = attestation?.issuedAt;

  const pinned = (input.expectedKeyId?.trim() || DEFAULT_PINNED_SIGNER).toLowerCase();
  const subjectMatch =
    !!attestation?.payload?.wallet &&
    normalizeWallet(attestation.payload.wallet) ===
      normalizeWallet(input.requestedWallet);

  const fail = (reason: string, ageSeconds?: number): PredgeVerifyResult => ({
    verified: false,
    reason,
    signer,
    subjectMatch,
    issuedAt,
    ageSeconds,
  });

  if (!attestation || typeof signature !== "string") {
    return fail("malformed attestation");
  }
  if (attestation.scheme !== PREDGE_SCHEME) {
    return fail(`unexpected scheme ${JSON.stringify(attestation.scheme)}`);
  }
  if (!signer || signer.toLowerCase() !== pinned) {
    // The finding that matters: without this, the responder chooses both the
    // key and the signature over it, and `verified` means nothing.
    return fail("signer is not the pinned Predge key");
  }
  if (!(await ed25519SignatureValid(attestation, signature))) {
    return fail("signature does not match payload");
  }
  if (!subjectMatch) {
    return fail("signal is about a different wallet");
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

function resolveBaseUrl(credentials: PredgeCredentials): string {
  const override = credentials.PREDGE_SIGNAL_URL?.trim();
  const base = override && override.length > 0 ? override : DEFAULT_PREDGE_SIGNAL_URL;
  return base.replace(TRAILING_SLASH_RE, "");
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
      return {
        success: false,
        error: `HTTP ${response.status}: ${response.statusText}`,
        errorClass:
          response.status >= 500
            ? ExecutionErrorType.EXTERNAL
            : ExecutionErrorType.USER,
      };
    }

    const data = (await response.json()) as PredgeSignedAttestation;
    return { success: true, data };
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
