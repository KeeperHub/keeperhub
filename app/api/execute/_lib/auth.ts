import "server-only";

import { authenticateApiKey } from "@/lib/api-key-auth";
import { authenticateOAuthToken } from "@/lib/mcp/oauth-auth";

export type ApiKeyContext = {
  organizationId: string;
  apiKeyId: string;
  scope?: string;
};

export type ApiKeyAuthError = { error: string; status: number };

/**
 * Validates a request for the direct execution API.
 * Accepts MCP OAuth tokens or API keys (kh_).
 * Returns the org context if valid, otherwise an `{ error, status }` failure
 * (401 for missing/invalid credentials, 403 for forbidden principals such as
 * anonymous accounts). Callers branch on `"error" in result`.
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
    };
  }

  if (result.statusCode === 403) {
    return { error: result.error ?? "Forbidden", status: 403 };
  }

  return { error: "Unauthorized", status: 401 };
}
