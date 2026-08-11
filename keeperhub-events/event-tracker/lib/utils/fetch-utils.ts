import { createHash, createHmac } from "node:crypto";
import { KEEPERHUB_API_URL } from "../config/environment";
import type { SyncData } from "../types";
import { logger } from "./logger";

const HMAC_CALLER = "events";

export function signHmacHeaders(
  method: string,
  url: string,
  body: string,
): Record<string, string> {
  const secret = process.env.INTERNAL_SERVICE_HMAC_SECRET ?? "";
  const pathname = new URL(url).pathname;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const bodyDigest = createHash("sha256").update(body).digest("hex");
  const signingString = `${method}\n${pathname}\n${HMAC_CALLER}\n${bodyDigest}\n${timestamp}`;
  const signature = createHmac("sha256", secret)
    .update(signingString)
    .digest("hex");
  return {
    "X-KH-Caller": HMAC_CALLER,
    "X-KH-Timestamp": timestamp,
    "X-KH-Signature": signature,
  };
}

export async function fetchActiveWorkflows(): Promise<SyncData | null> {
  const url = `${KEEPERHUB_API_URL}/api/workflows/events?active=true`;
  try {
    const response = await fetch(url, {
      headers: signHmacHeaders("GET", url, ""),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return (await response.json()) as SyncData;
  } catch (error: any) {
    logger.warn(`Failed to fetch active workflows: ${error.message}`);
    return null;
  }
}
