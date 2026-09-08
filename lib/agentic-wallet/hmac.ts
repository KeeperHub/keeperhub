/**
 * @security HMAC request-authentication primitive for /sign, /approval-request, /link.
 *
 * Signing string format (REVIEW HI-05 — subOrgId now bound into the signature
 * so the (subOrgId, secret) pair is a single signed unit instead of being
 * implicitly bound via lookupHmacSecret):
 *   signingString = `${method}\n${pathname}\n${subOrgId}\n${sha256_hex(body)}\n${timestamp}`
 *   signature     = hex(hmac_sha256(secret, signingString))
 *
 * Previously the subOrgId header was trusted because the HMAC verifier used
 * the caller-declared subOrgId to look up the secret; tampering with the
 * header made the signature no longer verify. That argument held in theory
 * but depended on lookupHmacSecret staying pure. Folding subOrgId into the
 * signed string makes the binding explicit and robust to future refactors.
 *
 * Headers: X-KH-Sub-Org, X-KH-Timestamp (unix seconds), X-KH-Signature (hex).
 * Optional: X-KH-Key-Version (positive integer) pins secret selection to a
 * specific row in agentic_wallet_hmac_secrets. When absent, the highest active
 * version is used. The key version is NOT part of the signing string — it
 * only affects which secret gets looked up. An attacker who tampered with the
 * header to force a different version would still need the correct secret for
 * that version to produce a matching signature.
 * Replay window: 300 seconds, symmetric (|now - ts| <= 300).
 *
 * Replay within the 300-second window is INTENTIONALLY accepted — see
 * 33-RESEARCH.md Pitfall 4 Option A. The underlying x402/MPP protocol nonce
 * prevents double-spend; adding a server-side nonce cache here would be
 * defense-in-depth with measurable latency cost. Revisit if a security review
 * requires strict single-use.
 *
 * T-33-01 (Spoofing) mitigations: all three headers required, timestamp
 * window, length pre-check before timingSafeEqual (avoid length-leak),
 * constant-time compare on the hex strings, subOrgId bound into the signed
 * string.
 *
 * T-33-02 (Information Disclosure) mitigation: never log the secret,
 * signature, or timestamp in error paths.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { listActiveHmacSecrets, lookupHmacSecret } from "./hmac-secret-store";

const REPLAY_WINDOW_SECONDS = 300;

export function computeSignature(
  secret: string,
  method: string,
  path: string,
  subOrgId: string,
  body: string,
  timestamp: string
): string {
  const bodyDigest = createHash("sha256").update(body).digest("hex");
  // REVIEW HI-05: subOrgId is now a signed field.
  const signingString = `${method}\n${path}\n${subOrgId}\n${bodyDigest}\n${timestamp}`;
  return createHmac("sha256", secret).update(signingString).digest("hex");
}

export type VerifyHmacResult =
  | { ok: true; subOrgId: string }
  | { ok: false; status: number; error: string };

export async function verifyHmacRequest(
  request: Request,
  body: string
): Promise<VerifyHmacResult> {
  const subOrgId = request.headers.get("X-KH-Sub-Org");
  const timestamp = request.headers.get("X-KH-Timestamp");
  const signature = request.headers.get("X-KH-Signature");

  if (!(subOrgId && timestamp && signature)) {
    return { ok: false, status: 401, error: "Missing HMAC headers" };
  }

  const now = Math.floor(Date.now() / 1000);
  const ts = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > REPLAY_WINDOW_SECONDS) {
    return { ok: false, status: 401, error: "Timestamp outside replay window" };
  }

  // REVIEW ME-04: length pre-check BEFORE the DB lookup. A sha256-hex
  // signature is always 64 chars; any other length is garbage and we can
  // reject it without touching the DB. This shrinks the DoS amplification
  // a random-subOrgId flood can cause -- only length-64 requests reach the
  // DB roundtrip path.
  //
  // Constant-length is safe to check non-constant-time (the length is not
  // secret; the timingSafeEqual below protects the byte contents).
  const EXPECTED_SIG_HEX_LEN = 64;
  if (signature.length !== EXPECTED_SIG_HEX_LEN) {
    return { ok: false, status: 401, error: "Invalid signature" };
  }

  const versionHeader = request.headers.get("X-KH-Key-Version");
  let pinnedVersion: number | undefined;
  if (versionHeader !== null) {
    const v = Number.parseInt(versionHeader, 10);
    if (!Number.isInteger(v) || v <= 0 || String(v) !== versionHeader.trim()) {
      return { ok: false, status: 401, error: "Invalid key version" };
    }
    pinnedVersion = v;
  }

  const url = new URL(request.url);
  const providedSigBuf = Buffer.from(signature, "hex");

  // Fix-pack-2 R3: without a pinned key version, try every active secret
  // (newest version first, then any still-within-grace older versions) so
  // rotation's 24-hour grace window actually gives legacy clients time to
  // pick up the new secret. With a pinned version, verify only against that
  // one row — callers who explicitly pin accept the strict match.
  const candidates =
    pinnedVersion === undefined
      ? await listActiveHmacSecrets(subOrgId)
      : await (async (): Promise<{ secret: string; keyVersion: number }[]> => {
          const single = await lookupHmacSecret(subOrgId, pinnedVersion);
          return single ? [single] : [];
        })();

  if (candidates.length === 0) {
    return { ok: false, status: 404, error: "Unknown sub-org" };
  }

  for (const candidate of candidates) {
    const expected = computeSignature(
      candidate.secret,
      request.method,
      url.pathname,
      subOrgId,
      body,
      timestamp
    );
    const expectedBuf = Buffer.from(expected, "hex");
    if (
      providedSigBuf.length === expectedBuf.length &&
      timingSafeEqual(providedSigBuf, expectedBuf)
    ) {
      return { ok: true, subOrgId };
    }
  }

  return { ok: false, status: 401, error: "Invalid signature" };
}
