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

// Predge serves verifiable smart-money signals over x402. Each signal arrives
// as a detached ed25519 attestation over a canonical encoding of the payload,
// so a workflow can confirm the number was issued by Predge and was not altered
// in flight -- with no call back to Predge and no trust in the transport.
//
// Default hosted signal service. Point PREDGE_SIGNAL_URL at your own Predge
// deployment (or the local dev service) to override.
const DEFAULT_PREDGE_SIGNAL_URL = "https://api.predge.io";
const TRAILING_SLASH_RE = /\/+$/;

// The signature scheme Predge stamps on every attestation.
const PREDGE_SCHEME = "veri402-ed25519-v1";

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

// Deterministic JSON: object keys sorted recursively, so signer and verifier
// hash the exact same bytes regardless of key order. Mirrors Predge's signer.
function canonicalize(value: unknown): string {
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

/**
 * Offline ed25519 verification via WebCrypto -- no external dependency and no
 * call back to Predge. Returns false on any malformed input rather than
 * throwing, so a bad signature is a clean "not verified".
 */
export async function verifySignedAttestation(
  signed: PredgeSignedAttestation,
  expectedKeyId?: string
): Promise<boolean> {
  try {
    const { attestation, signature } = signed;
    if (attestation?.scheme !== PREDGE_SCHEME) {
      return false;
    }
    if (expectedKeyId && attestation.keyId.toLowerCase() !== expectedKeyId.toLowerCase()) {
      return false;
    }
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

function resolveBaseUrl(credentials: PredgeCredentials): string {
  const override = credentials.PREDGE_SIGNAL_URL?.trim();
  const base = override && override.length > 0 ? override : DEFAULT_PREDGE_SIGNAL_URL;
  return base.replace(TRAILING_SLASH_RE, "");
}

/**
 * Fetch a signed Predge signal for a wallet. Read-only GET through safeFetch so
 * the SSRF guard attributes every request; the base URL is user-configurable so
 * it is validated with `assertUrlIsPublic` first (always-on, ignores shadow
 * mode). Mirrors plugins/blockscout/steps/blockscout-core.ts.
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
    });

    if (!response.ok) {
      if (response.status === 404) {
        return {
          success: false,
          error: "No Predge signal for this wallet.",
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
