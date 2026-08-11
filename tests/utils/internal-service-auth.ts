/**
 * Shared helper to sign internal service-to-service requests for tests.
 *
 * Mirrors the canonical signing string used by the verifier
 * (lib/internal-service-auth.ts) and the producers
 * (e.g. keeperhub-executor/api-execute.ts):
 *   `${method}\n${pathname}\n${caller}\n${sha256_hex(body)}\n${timestamp}`
 *   signature = hex(hmac_sha256(secret, signingString))
 *
 * `caller` must be a valid InternalCaller; for v1 every producer shares one
 * signing secret, so any caller verifies against the same `secret`.
 */

import { createHash, createHmac } from "node:crypto";

export function signInternalServiceHeaders(opts: {
  method: string;
  url: string;
  caller: string;
  secret: string;
  body?: string;
  timestamp?: string;
}): Record<string, string> {
  const body = opts.body ?? "";
  const pathname = new URL(opts.url).pathname;
  const timestamp = opts.timestamp ?? String(Math.floor(Date.now() / 1000));
  const bodyDigest = createHash("sha256").update(body).digest("hex");
  const signingString = `${opts.method}\n${pathname}\n${opts.caller}\n${bodyDigest}\n${timestamp}`;
  const signature = createHmac("sha256", opts.secret)
    .update(signingString)
    .digest("hex");
  return {
    "X-KH-Caller": opts.caller,
    "X-KH-Timestamp": timestamp,
    "X-KH-Signature": signature,
  };
}
