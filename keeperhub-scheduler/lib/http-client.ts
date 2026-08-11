import { createHash, createHmac } from "node:crypto";
import { KEEPERHUB_URL } from "./config.js";

const HMAC_CALLER = "scheduler";

function signHmacHeaders(
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

export async function apiRequest<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const url = `${KEEPERHUB_URL}${path}`;
  const method = (options.method ?? "GET").toUpperCase();
  const body = typeof options.body === "string" ? options.body : "";
  const hmacHeaders = signHmacHeaders(method, url, body);

  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...hmacHeaders,
      ...options.headers,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `API ${options.method || "GET"} ${path} failed: ${response.status} ${text}`,
    );
  }

  return response.json() as Promise<T>;
}
