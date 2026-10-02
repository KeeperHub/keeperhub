import { stripTrailingSlashes } from "@/lib/utils/url";

export const dynamic = "force-dynamic";

function deriveBaseUrl(request: Request): string {
  const envUrl = process.env.NEXT_PUBLIC_APP_URL ?? process.env.BETTER_AUTH_URL;
  if (envUrl) {
    return stripTrailingSlashes(envUrl);
  }
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

export function GET(request: Request): Response {
  const baseUrl = deriveBaseUrl(request);
  const metadata = {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/oauth/authorize`,
    token_endpoint: `${baseUrl}/api/oauth/token`,
    registration_endpoint: `${baseUrl}/api/oauth/register`,
    scopes_supported: ["mcp:read", "mcp:write", "mcp:admin"],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: [
      "client_secret_basic",
      "client_secret_post",
      "none",
    ],
    code_challenge_methods_supported: ["S256"],
  };
  return Response.json(metadata);
}
