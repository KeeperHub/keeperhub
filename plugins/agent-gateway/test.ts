/**
 * Connection test for the Agent Gateway integration.
 *
 * This file is reachable from the client-bundled plugin registry, so it can
 * import neither steps/hmac-request-core.ts nor lib/agentic-wallet/hmac.ts -
 * both are "server-only", and the latter pulls in node:crypto and the HMAC
 * secret store. The signing string below is therefore restated over Web
 * Crypto; it must stay identical to `computeSignature` in
 * lib/agentic-wallet/hmac.ts, which is the canonical definition. A drift
 * shows up as a 401 from the test, never as a weaker check.
 *
 * Raw `fetch` is used for the same reason - see the exception documented in
 * plugins/AGENTS.md and the "Forbid raw network egress in plugins" CI check.
 */
const KEEPERHUB_APP_URL = (
  process.env.NEXT_PUBLIC_APP_URL ?? "https://app.keeperhub.com"
).replace(/\/+$/, "");

const CREDIT_PATH = "/api/agentic-wallet/credit";

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function computeSignature(
  secret: string,
  method: string,
  path: string,
  subOrgId: string,
  body: string,
  timestamp: string
): Promise<string> {
  const encoder = new TextEncoder();
  const bodyDigest = toHex(
    await crypto.subtle.digest("SHA-256", encoder.encode(body))
  );
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signingString = `${method}\n${path}\n${subOrgId}\n${bodyDigest}\n${timestamp}`;

  return toHex(
    await crypto.subtle.sign("HMAC", key, encoder.encode(signingString))
  );
}

export async function testAgentGateway(credentials: Record<string, string>) {
  try {
    const subOrgId = credentials.AGENT_GATEWAY_SUB_ORG_ID;
    const hmacSecret = credentials.AGENT_GATEWAY_HMAC_SECRET;

    if (!(subOrgId && hmacSecret)) {
      return {
        success: false,
        error:
          "Sub-Org ID and HMAC Secret are required. Provision a wallet via POST /api/agentic-wallet/provision and enter the returned values here.",
      };
    }

    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = await computeSignature(
      hmacSecret,
      "GET",
      CREDIT_PATH,
      subOrgId,
      "",
      timestamp
    );

    const response = await fetch(`${KEEPERHUB_APP_URL}${CREDIT_PATH}`, {
      method: "GET",
      headers: {
        "X-KH-Sub-Org": subOrgId,
        "X-KH-Timestamp": timestamp,
        "X-KH-Signature": signature,
      },
    });

    if (!response.ok) {
      if (response.status === 401) {
        return {
          success: false,
          error: "Invalid HMAC secret for this sub-org",
        };
      }
      if (response.status === 404) {
        return {
          success: false,
          error: "Unknown sub-org. Check the Sub-Org ID.",
        };
      }
      return {
        success: false,
        error: `Connection failed: HTTP ${response.status}`,
      };
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
