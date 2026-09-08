import "server-only";

import { authenticateApiKey } from "@/lib/api-key-auth";
import { authenticateOAuthToken } from "@/lib/mcp/oauth-auth";
import type { AuthMethod } from "@/lib/middleware/auth-helpers";

export type ApiKeyContext = {
  organizationId: string;
  apiKeyId: string;
  scope?: string;
  /**
   * Which credential family authenticated the call. A scope denial's
   * remediation differs between the two -- an OAuth grant is widened by an
   * admin, an API key's scope is fixed at creation -- so requireScope needs to
   * know which one it is talking to.
   */
  credentialType: Extract<AuthMethod, "oauth" | "api-key">;
};

export type ApiKeyAuthError = { error: string; status: number };

/**
 * Validates a request for the direct execution API.
 * Accepts MCP OAuth tokens or API keys (kh_).
 * Returns the org context if valid, otherwise an `{ error, status }` failure
 * (401 for missing/invalid credentials, 403 for forbidden principals such as
 * anonymous accounts). Callers branch on `"error" in result`.
 *
 * `scope` carries whatever the credential was minted with, for both branches,
 * so the routes' requireScope() gates apply to API keys as well as OAuth
 * tokens. It is undefined only when the credential has no scope at all (an
 * API key whose `scope` column is NULL), which stays full-access.
 */
export async function validateApiKey(
  request: Request
): Promise<ApiKeyContext | ApiKeyAuthError> {
  const oauthResult = await authenticateOAuthToken(request);
  if (oauthResult.authenticated && oauthResult.organizationId) {
    return {
      organizationId: oauthResult.organizationId,
      apiKeyId: `oauth:${oauthResult.userId ?? "unknown"}`,
      scope: oauthResult.scope,
      credentialType: "oauth",
    };
  }

  // A forbidden OAuth subject (e.g. an anonymous account) must surface as 403
  // rather than fall through to api-key auth. Other OAuth failures (no header,
  // kh_ token, invalid token) are 401 and the api-key path handles them.
  if (oauthResult.statusCode === 403) {
    return { error: oauthResult.error ?? "Forbidden", status: 403 };
  }

  const result = await authenticateApiKey(request);
  if (result.authenticated && result.organizationId && result.apiKeyId) {
    return {
      organizationId: result.organizationId,
      apiKeyId: result.apiKeyId,
      scope: result.scope,
      credentialType: "api-key",
    };
  }

  if (result.statusCode === 403) {
    return { error: result.error ?? "Forbidden", status: 403 };
  }

  return { error: "Unauthorized", status: 401 };
}
