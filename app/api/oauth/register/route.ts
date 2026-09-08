import { createHash, randomBytes } from "node:crypto";
import { HttpStatus } from "@/lib/http-status";
import { normalizeScope } from "@/lib/mcp/oauth-scopes";
import { type OAuthClient, storeOAuthClient } from "@/lib/mcp/oauth-store";
import { checkIpRateLimit, getClientIp } from "@/lib/mcp/rate-limit";
import { isAllowedRedirectUri } from "@/lib/mcp/redirect-uri";
import { applyRateLimitHeaders } from "@/lib/rate-limit-headers";
import { oauthRegisterSchema } from "@/lib/schemas/oauth";
import { validateData } from "@/lib/validate-request";

export const dynamic = "force-dynamic";

const TRAILING_SLASH = /\/$/;

function deriveBaseUrl(request: Request): string {
  const envUrl = process.env.NEXT_PUBLIC_APP_URL ?? process.env.BETTER_AUTH_URL;
  if (envUrl) {
    return envUrl.replace(TRAILING_SLASH, "");
  }
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

type TokenEndpointAuthMethod =
  | "client_secret_basic"
  | "client_secret_post"
  | "none";

const SUPPORTED_AUTH_METHODS: readonly TokenEndpointAuthMethod[] = [
  "client_secret_basic",
  "client_secret_post",
  "none",
];

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

// A client is confidential only when it explicitly registers
// client_secret_post or client_secret_basic. A missing method defaults to
// "none" (public PKCE), matching the column default and OAuth 2.1 / MCP
// public-client expectations. Secret enforcement on the token endpoint
// applies only to clients registered after this change.
function resolveAuthMethod(value: unknown): TokenEndpointAuthMethod {
  if (typeof value === "string") {
    const match = SUPPORTED_AUTH_METHODS.find((m) => m === value);
    if (match) {
      return match;
    }
  }
  return "none";
}

export async function POST(request: Request): Promise<Response> {
  const ip = getClientIp(request);
  const rateLimit = checkIpRateLimit(ip, 10, 60_000);
  if (!rateLimit.allowed) {
    return applyRateLimitHeaders(
      Response.json(
        { error: "Too many requests" },
        { status: HttpStatus.TOO_MANY_REQUESTS }
      ),
      rateLimit
    );
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return Response.json(
      { error: "Invalid JSON body" },
      { status: HttpStatus.BAD_REQUEST }
    );
  }

  const parsed = validateData(rawBody, oauthRegisterSchema);
  if (!parsed.success) {
    return parsed.response;
  }

  const {
    client_name,
    redirect_uris,
    scope,
    grant_types,
    token_endpoint_auth_method,
  } = parsed.data;
  const authMethod = resolveAuthMethod(token_endpoint_auth_method);

  for (const uri of redirect_uris) {
    if (!isAllowedRedirectUri(uri)) {
      return Response.json(
        {
          error: `Invalid redirect_uri: ${uri}. Must be https, or http on a loopback host (localhost, 127.0.0.1, [::1]).`,
        },
        { status: HttpStatus.BAD_REQUEST }
      );
    }
  }

  // Default to full read+write when the client omits `scope`. Standard MCP
  // DCR clients (Anthropic reference, Hydra, etc.) don't pass scope, so
  // defaulting to `mcp:read` only left them silently 401ing on every write
  // tool (KEEP-483). Matches the authorize-page default.
  const resolvedScope = normalizeScope(
    typeof scope === "string" ? scope : "mcp:read mcp:write"
  );

  const resolvedGrantTypes = isStringArray(grant_types)
    ? grant_types.filter((g) =>
        ["authorization_code", "refresh_token"].includes(g)
      )
    : ["authorization_code", "refresh_token"];

  if (resolvedGrantTypes.length === 0) {
    resolvedGrantTypes.push("authorization_code", "refresh_token");
  }

  const clientId = crypto.randomUUID();
  const clientSecretRaw = randomBytes(32).toString("hex");
  const clientSecretHash = createHash("sha256")
    .update(clientSecretRaw)
    .digest("hex");

  const client: OAuthClient = {
    clientId,
    clientSecretHash,
    tokenEndpointAuthMethod: authMethod,
    clientName: client_name.trim(),
    redirectUris: redirect_uris,
    scopes: resolvedScope.split(" "),
    grantTypes: resolvedGrantTypes,
    organizationId: null,
    createdAt: Date.now(),
  };

  await storeOAuthClient(client);

  // Public clients (RFC 8252 native apps) register with
  // `token_endpoint_auth_method: "none"` and rely on PKCE. Returning a
  // client_secret in that case contradicts what the client asked for and
  // causes strict MCP hosts (e.g. Claude Desktop's connector validator) to
  // reject the registration. Store a secret hash either way so the schema
  // stays stable, but only expose it for confidential-client registrations.
  const baseUrl = deriveBaseUrl(request);
  const responseBase = {
    client_id: clientId,
    client_id_issued_at: Math.floor(client.createdAt / 1000),
    client_name: client.clientName,
    redirect_uris: client.redirectUris,
    grant_types: client.grantTypes,
    response_types: ["code"],
    token_endpoint_auth_method: authMethod,
    scope: resolvedScope,
    // RFC 7591 §3.2.1 management endpoint. Linear/Notion return this; some
    // strict validators treat its absence as an incomplete registration.
    registration_client_uri: `${baseUrl}/api/oauth/register/${clientId}`,
  };
  const responseBody =
    authMethod === "none"
      ? responseBase
      : { ...responseBase, client_secret: clientSecretRaw };

  return applyRateLimitHeaders(
    Response.json(responseBody, { status: HttpStatus.CREATED }),
    rateLimit
  );
}
