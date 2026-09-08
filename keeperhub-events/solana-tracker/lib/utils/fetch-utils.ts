import { createHash, createHmac } from "node:crypto";

/**
 * HMAC signing for internal-service HTTP requests. SIGN-ONLY copy of the shared
 * scheme in the app's lib/internal-service-auth.ts (this package cannot import
 * root lib/). The app holds the verify half.
 *
 * Unlike the EVM event-tracker (which is hardwired to caller "events"), this
 * service talks to BOTH the event discovery endpoint (caller "events") and the
 * block-workflow discovery endpoint (caller "scheduler"), so the caller is a
 * parameter.
 */

export type HmacCaller = "events" | "scheduler";

export function signHmacHeaders(
  method: string,
  url: string,
  body: string,
  caller: HmacCaller,
): Record<string, string> {
  const secret = process.env.INTERNAL_SERVICE_HMAC_SECRET ?? "";
  const pathname = new URL(url).pathname;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const bodyDigest = createHash("sha256").update(body).digest("hex");
  const signingString = `${method}\n${pathname}\n${caller}\n${bodyDigest}\n${timestamp}`;
  const signature = createHmac("sha256", secret)
    .update(signingString)
    .digest("hex");
  return {
    "X-KH-Caller": caller,
    "X-KH-Timestamp": timestamp,
    "X-KH-Signature": signature,
  };
}
