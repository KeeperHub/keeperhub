import { createHash, createHmac } from "node:crypto";
import type { MessageAttributeValue } from "@aws-sdk/client-sqs";

/**
 * SQS message signing for the scheduler (block + schedule dispatchers).
 *
 * SIGN-ONLY copy of the shared scheme in the app's lib/sqs-message-auth.ts. The
 * scheduler is an isolated package that cannot import root lib/, so the signing
 * logic is duplicated here (same convention as this package's log-facade.ts and
 * http-client.ts signHmacHeaders). The executor holds the verify half.
 *
 * Keep the signing string, attribute names, and caller set identical to
 * lib/sqs-message-auth.ts - the shared anti-drift test vector guards this.
 */

export type SqsHmacCaller = "scheduler" | "events" | "app";

export const SQS_SIGNATURE_ATTR = "X-KH-Signature";
export const SQS_TIMESTAMP_ATTR = "X-KH-Timestamp";
export const SQS_CALLER_ATTR = "X-KH-Caller";

function computeSqsSignature(
  secret: string,
  queueUrl: string,
  caller: string,
  body: string,
  timestamp: string,
): string {
  const bodyDigest = createHash("sha256").update(body).digest("hex");
  const signingString = `sqs\n${queueUrl}\n${caller}\n${bodyDigest}\n${timestamp}`;
  return createHmac("sha256", secret).update(signingString).digest("hex");
}

export function signSqsMessageAttributes(
  caller: SqsHmacCaller,
  queueUrl: string,
  body: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Record<string, MessageAttributeValue> {
  const secret = process.env.INTERNAL_SERVICE_HMAC_SECRET;
  // Fail loud rather than sign with "" (see lib/sqs-message-auth.ts): a
  // ""-signed message is dropped by the verifier in enforce mode.
  if (!secret) {
    throw new Error(
      "INTERNAL_SERVICE_HMAC_SECRET is not set; refusing to enqueue an unsigned SQS message",
    );
  }
  const timestamp = String(nowSeconds);
  const signature = computeSqsSignature(
    secret,
    queueUrl,
    caller,
    body,
    timestamp,
  );
  return {
    [SQS_CALLER_ATTR]: { DataType: "String", StringValue: caller },
    [SQS_TIMESTAMP_ATTR]: { DataType: "String", StringValue: timestamp },
    [SQS_SIGNATURE_ATTR]: { DataType: "String", StringValue: signature },
  };
}
