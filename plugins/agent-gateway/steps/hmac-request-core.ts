/**
 * Shared HMAC request-signing logic for calling KeeperHub's own
 * agentic-wallet API (/api/agentic-wallet/sign, /api/agentic-wallet/credit)
 * as an external client.
 *
 * IMPORTANT: This file must NOT contain "use step" or be a step file.
 *
 * Mirrors the canonical HMAC signing primitive from lib/agentic-wallet/hmac.ts
 * using pure node:crypto to prevent pulling transitive KMS/DB/schema dependencies
 * into workflow step bundles, maintaining exact 1:1 algorithmic parity with
 * server-side request verification.
 */
import "server-only";

import { createHash, createHmac } from "node:crypto";
import { safeFetch } from "@/lib/safe-fetch";
import { appUrl } from "@/lib/site/identity";
import type { AgentGatewayCredentials } from "../credentials";

export function computeSignature(
  secret: string,
  method: string,
  path: string,
  subOrgId: string,
  body: string,
  timestamp: string
): string {
  const bodyDigest = createHash("sha256").update(body).digest("hex");
  const signingString = `${method}\n${path}\n${subOrgId}\n${bodyDigest}\n${timestamp}`;
  return createHmac("sha256", secret).update(signingString).digest("hex");
}

export const MISSING_CREDENTIALS_ERROR =
  "Missing agent-gateway credentials (Sub-Org ID / HMAC Secret). Provision a wallet via POST /api/agentic-wallet/provision, then select an Agent Gateway connection holding the returned subOrgId and hmacSecret on this node.";

export type HmacCredentials = {
  subOrgId: string;
  hmacSecret: string;
};

/**
 * Narrow the connection's credential record - keyed by the formFields' envVar
 * names, which is what fetchCredentials returns - to the pair the signer
 * needs. Returns null when either half is absent so each core can surface its
 * own missing-credentials result instead of signing with a partial identity.
 */
export function toHmacCredentials(
  credentials: AgentGatewayCredentials
): HmacCredentials | null {
  const subOrgId = credentials.AGENT_GATEWAY_SUB_ORG_ID;
  const hmacSecret = credentials.AGENT_GATEWAY_HMAC_SECRET;

  if (!(subOrgId && hmacSecret)) {
    return null;
  }

  return { subOrgId, hmacSecret };
}

export async function hmacSignedRequest(
  signer: HmacCredentials,
  method: "GET" | "POST",
  pathname: string,
  body?: unknown
): Promise<Response> {
  const bodyStr = body === undefined ? "" : JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = computeSignature(
    signer.hmacSecret,
    method,
    pathname,
    signer.subOrgId,
    bodyStr,
    timestamp
  );

  return safeFetch(`${appUrl()}${pathname}`, {
    method,
    plugin: "agent-gateway",
    headers: {
      "Content-Type": "application/json",
      "X-KH-Sub-Org": signer.subOrgId,
      "X-KH-Timestamp": timestamp,
      "X-KH-Signature": signature,
    },
    ...(body === undefined ? {} : { body: bodyStr }),
  });
}
