import { HttpStatus } from "@/lib/http-status";
import "server-only";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { type ApiKeyAuthResult, authenticateApiKey } from "@/lib/api-key-auth";
import { McpEventStore } from "@/lib/mcp/event-store";
import { getInternalApiBaseUrl } from "@/lib/mcp/internal-url";
import { logMcpEvent } from "@/lib/mcp/logging";
import { normalizeToolCallArguments } from "@/lib/mcp/normalize-tool-call-arguments";
import { authenticateOAuthToken } from "@/lib/mcp/oauth-auth";
import { checkMcpRateLimit, type RateLimitResult } from "@/lib/mcp/rate-limit";
import { createMcpServer } from "@/lib/mcp/server";
import { buildSessionErrorResponse } from "@/lib/mcp/session-error";
import {
  createSessionToken,
  verifySessionToken,
  verifySessionTokenDetailed,
} from "@/lib/mcp/session-token";
import {
  deleteSession,
  getSession,
  type SessionEntry,
  setSession,
  startCleanupInterval,
  touchSession,
} from "@/lib/mcp/sessions";
import type { AuthMethod } from "@/lib/middleware/auth-helpers";
import {
  applyRateLimitHeaders,
  rateLimitHeaders,
} from "@/lib/rate-limit-headers";

export const dynamic = "force-dynamic";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, WWW-Authenticate",
} as const;

// Start the local-cache cleanup interval once per process lifetime.
startCleanupInterval();

const TRAILING_SLASH = /\/$/;

/**
 * Ensure the request carries the Accept header the MCP SDK requires.
 * Some MCP clients (e.g. Claude Code) omit `text/event-stream` from Accept,
 * which causes the SDK to return 406 even when `enableJsonResponse` is true.
 * We patch the header here so the transport's strict check passes.
 */
function ensureMcpAcceptHeader(request: Request): Request {
  const accept = request.headers.get("accept") ?? "";
  const hasJson = accept.includes("application/json");
  const hasSse = accept.includes("text/event-stream");

  if (hasJson && hasSse) {
    return request;
  }

  const parts = accept ? [accept] : [];
  if (!hasJson) {
    parts.push("application/json");
  }
  if (!hasSse) {
    parts.push("text/event-stream");
  }

  const headers = new Headers(request.headers);
  headers.set("accept", parts.join(", "));
  // Body is not forwarded here. POST callers always supply parsedBody to the
  // SDK transport separately, and GET has no body. Re-attaching request.body
  // would fail on POST because the early body parse has already consumed it.
  return new Request(request.url, {
    method: request.method,
    headers,
  });
}

function getBaseUrl(request: Request): string {
  const envUrl = process.env.NEXT_PUBLIC_APP_URL ?? process.env.BETTER_AUTH_URL;
  if (envUrl) {
    return envUrl.replace(TRAILING_SLASH, "");
  }
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

// RFC 9728 / MCP 2025-06-18 require a WWW-Authenticate header on 401 responses
// so clients can discover the Protected Resource Metadata document. Without it,
// strict MCP clients (e.g. Claude Desktop) report "Couldn't reach the MCP server"
// because they cannot locate the authorization server.
//
// Per RFC 6750 §3, Bearer challenges include error + error_description when a
// token is missing/invalid. The MCP host on claude.ai appears to require these
// parameters during its discovery validation; omitting them causes the connect
// flow to halt at `start_error` before DCR ever runs. We match Linear, Sentry,
// and Notion's challenge shape.
function unauthorizedResponse(request: Request): Response {
  const baseUrl = getBaseUrl(request);
  const resourceMetadataUrl = `${baseUrl}/.well-known/oauth-protected-resource`;
  const challenge = [
    'Bearer realm="OAuth"',
    `resource_metadata="${resourceMetadataUrl}"`,
    'error="invalid_token"',
    'error_description="Missing or invalid access token"',
  ].join(", ");
  // RFC 6749 §5.2 error response. Match Linear/Notion/Sentry's body shape so
  // any OAuth 2.1 parser (including Anthropic's connector validator) can read
  // the error consistently with the WWW-Authenticate challenge.
  const body = {
    error: "invalid_token",
    error_description: "Missing or invalid access token",
  };
  return new Response(JSON.stringify(body), {
    status: HttpStatus.UNAUTHORIZED,
    headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": challenge,
      ...CORS_HEADERS,
    },
  });
}

async function authenticate(request: Request): Promise<ApiKeyAuthResult> {
  const authHeader = request.headers.get("Authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.substring(7) : "";

  if (token.startsWith("kh_")) {
    return await authenticateApiKey(request);
  }

  const oauthResult = await authenticateOAuthToken(request);
  if (oauthResult.authenticated) {
    return {
      authenticated: true,
      organizationId: oauthResult.organizationId,
      userId: oauthResult.userId,
      apiKeyId: `oauth:${oauthResult.userId ?? "unknown"}`,
      scope: oauthResult.scope,
    };
  }

  // Fall back to API key auth to get a consistent error format for non-OAuth tokens.
  return await authenticateApiKey(request);
}

function isInitializeRequestBody(body: unknown): boolean {
  if (Array.isArray(body)) {
    return body.length > 0 && body.every((item) => isInitializeRequest(item));
  }
  return isInitializeRequest(body);
}

function rateLimitResponse(
  rateLimit: Extract<RateLimitResult, { allowed: false }>
): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32_029, message: "Rate limit exceeded" },
      id: null,
    }),
    {
      status: HttpStatus.TOO_MANY_REQUESTS,
      headers: {
        "Content-Type": "application/json",
        ...rateLimitHeaders(rateLimit),
        ...CORS_HEADERS,
      },
    }
  );
}

export function OPTIONS(): Response {
  return new Response(null, {
    status: HttpStatus.NO_CONTENT,
    headers: CORS_HEADERS,
  });
}

type BuiltSession = {
  transport: WebStandardStreamableHTTPServerTransport;
  entry: SessionEntry;
};

/**
 * The session token carries the credential id but not which family issued it,
 * and a reconstructed session has nothing else to go on. authenticate() builds
 * `oauth:<userId>` for OAuth and uses the key row id for kh_ keys, so the
 * prefix is the one signal that survives. Derived here only, so the convention
 * has a single reader rather than being re-tested wherever it is needed.
 */
function credentialFamily(apiKeyId: string): AuthMethod {
  return apiKeyId.startsWith("oauth:") ? "oauth" : "api-key";
}

function buildSession(
  sessionId: string,
  organizationId: string,
  apiKeyId: string,
  scope: string | undefined,
  internalApiBaseUrl: string,
  authHeader: string
): BuiltSession {
  const eventStore = new McpEventStore();

  // Passing () => sessionId as the generator ensures the transport uses the
  // provided session ID both for fresh sessions and for reconstructed
  // cross-pod sessions, so it validates incoming Mcp-Session-Id headers correctly.
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => sessionId,
    eventStore,
    onsessioninitialized: (sid) => {
      setSession(sid, entry);
    },
    onsessionclosed: (sid) => {
      deleteSession(sid);
    },
    enableJsonResponse: true,
  });

  const server = createMcpServer(
    internalApiBaseUrl,
    authHeader,
    scope,
    credentialFamily(apiKeyId)
  );

  const entry: SessionEntry = {
    transport,
    server,
    eventStore,
    organizationId,
    apiKeyId,
    scope,
    createdAt: Date.now(),
    lastActivity: Date.now(),
  };

  return { transport, entry };
}

type ResolveSessionOk = {
  ok: true;
  transport: WebStandardStreamableHTTPServerTransport;
  renewedSessionId?: string;
};

type ResolveSessionError = {
  ok: false;
  code: "session_not_found" | "session_expired";
};

type ResolveSessionResult = ResolveSessionOk | ResolveSessionError;

async function resolveSession(
  sessionId: string,
  organizationId: string,
  callerApiKeyId: string,
  request: Request
): Promise<ResolveSessionResult> {
  // Fast path: same-pod cache hit.
  const cached = getSession(sessionId);
  if (cached) {
    if (
      cached.organizationId !== organizationId ||
      cached.apiKeyId !== callerApiKeyId
    ) {
      return { ok: false, code: "session_not_found" };
    }
    touchSession(sessionId);
    return { ok: true, transport: cached.transport };
  }

  // Slow path: verify JWT and reconstruct transport+server (different pod or restart).
  // Accept expired-but-valid-signature JWTs so sessions survive pod restarts
  // and idle periods within the 24h sliding window.
  const result = await verifySessionTokenDetailed(sessionId);

  if (!result.payload) {
    const isExpiredBeyondRenewal =
      "reason" in result &&
      (result.reason === "too_old" ||
        result.reason === "max_lifetime_exceeded");
    return {
      ok: false,
      code: isExpiredBeyondRenewal ? "session_expired" : "session_not_found",
    };
  }

  // Bind the session to the principal that created it. The JWT's `key`
  // (apiKeyId) claim is signed by MCP_SESSION_SECRET, so a leaked secret would
  // otherwise let any authenticated caller forge a token pinned to a different
  // principal's apiKeyId. Requiring it to match the freshly-authenticated
  // caller (whose key/token authenticate() already validated live) closes that
  // and rejects sessions whose underlying key was revoked or rotated.
  if (
    result.payload.org !== organizationId ||
    result.payload.key !== callerApiKeyId
  ) {
    return { ok: false, code: "session_not_found" };
  }

  logMcpEvent("mcp.session.reconstructed", {
    sessionId,
    orgId: organizationId,
  });

  const internalApiBaseUrl = getInternalApiBaseUrl();
  // Re-derive the auth header from the current request so tool calls in this
  // reconstructed session use the caller's credentials.
  const authHeader = request.headers.get("authorization") ?? "";
  const { transport, entry } = buildSession(
    sessionId,
    organizationId,
    result.payload.key,
    result.payload.scope,
    internalApiBaseUrl,
    authHeader
  );

  await entry.server.connect(transport);

  // The SDK's transport tracks an `_initialized` flag that is only set when it
  // processes an actual `initialize` JSON-RPC message.  Reconstructed sessions
  // skip that step, so the flag stays false and every subsequent request is
  // rejected with "Server not initialized".  The valid JWT proves the client
  // already completed initialization, so we mark both fields directly.
  const reconstructed = transport as unknown as {
    _initialized: boolean;
    sessionId: string;
  };
  reconstructed._initialized = true;
  reconstructed.sessionId = sessionId;

  // Cache locally for subsequent same-pod requests.
  setSession(sessionId, entry);

  // If the JWT was expired, mint a fresh one with a new 24h window (sliding renewal).
  // The client adopts the new session ID from the Mcp-Session-Id response header.
  let renewedSessionId: string | undefined;
  if (result.expired) {
    renewedSessionId = await createSessionToken({
      org: result.payload.org,
      key: result.payload.key,
      scope: result.payload.scope,
      original_iat: result.payload.original_iat ?? result.payload.iat,
    });

    // Cache under the renewed ID so the client's next request hits the fast path.
    setSession(renewedSessionId, entry);
    deleteSession(sessionId);

    logMcpEvent("mcp.session.renewed", {
      oldSessionId: sessionId,
      newSessionId: renewedSessionId,
      orgId: organizationId,
    });
  }

  return { ok: true, transport, renewedSessionId };
}

function withRenewedSessionHeader(
  response: Response,
  renewedSessionId: string | undefined
): Response {
  if (!renewedSessionId) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.set("Mcp-Session-Id", renewedSessionId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function POST(request: Request): Promise<Response> {
  // Parse body early so we can inspect it before the auth check.
  // A body that won't parse falls through to the existing 401 path.
  let body: unknown;
  let bodyParsed = false;
  try {
    body = normalizeToolCallArguments(await request.json());
    bodyParsed = true;
  } catch {
    // Leave bodyParsed = false; handled below after auth check.
  }

  const auth = await authenticate(request);

  // Anonymous initialize: let unauthenticated callers learn the server
  // identity and auth requirements without touching the SDK.
  if (!auth.authenticated && bodyParsed && isInitializeRequestBody(body)) {
    const baseUrl = getBaseUrl(request);
    const resourceMetadataUrl = `${baseUrl}/.well-known/oauth-protected-resource`;
    const rawId = Array.isArray(body)
      ? undefined
      : (body as Record<string, unknown>).id;
    // JSON-RPC 2.0 ids are string | number | null. Reflecting any other
    // shape — or an unbounded-length string — lets a caller force the
    // server to serialize an arbitrary value back into the response body.
    const requestId =
      (typeof rawId === "string" && rawId.length <= 256) ||
      typeof rawId === "number"
        ? rawId
        : null;
    const anonInitResult = {
      jsonrpc: "2.0",
      id: requestId,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        serverInfo: { name: "keeperhub", version: "1.2.0" },
        authentication: {
          required: true,
          resource_metadata: resourceMetadataUrl,
        },
      },
    };
    return new Response(JSON.stringify(anonInitResult), {
      status: HttpStatus.OK,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        ...CORS_HEADERS,
      },
    });
  }

  if (!auth.authenticated) {
    const reason = auth.error ?? "Unauthorized";
    logMcpEvent("mcp.auth.failed", { reason });
    if ((auth.statusCode ?? 401) === 401) {
      return unauthorizedResponse(request);
    }
    return new Response(JSON.stringify({ error: reason }), {
      status: auth.statusCode,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }

  const organizationId = auth.organizationId ?? "";

  const rateLimit = await checkMcpRateLimit(organizationId);
  if (!rateLimit.allowed) {
    logMcpEvent("mcp.rate.limited", { orgId: organizationId });
    return rateLimitResponse(rateLimit);
  }

  const sessionId = request.headers.get("mcp-session-id");

  // The early body parse above consumed request.body, so every transport
  // call from here on must hand the parsed value through parsedBody.
  if (!bodyParsed) {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: HttpStatus.BAD_REQUEST,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }

  if (sessionId) {
    const resolved = await resolveSession(
      sessionId,
      organizationId,
      auth.apiKeyId ?? "",
      request
    );
    if (!resolved.ok) {
      return buildSessionErrorResponse(resolved.code, {
        headers: CORS_HEADERS,
      });
    }
    const response = await resolved.transport.handleRequest(
      ensureMcpAcceptHeader(request),
      { parsedBody: body }
    );
    return applyRateLimitHeaders(
      withRenewedSessionHeader(response, resolved.renewedSessionId),
      rateLimit
    );
  }

  if (!isInitializeRequestBody(body)) {
    // No session header AND not an `initialize` request: the caller is
    // attempting tools/list or tools/call before completing the bootstrap
    // handshake. Surface -32003 so clients can branch on the code and run
    // the documented `initialize` -> `notifications/initialized` sequence
    // before retrying.
    return buildSessionErrorResponse("session_not_initialized", {
      headers: CORS_HEADERS,
    });
  }

  if (!(auth.organizationId && auth.apiKeyId)) {
    return new Response(
      JSON.stringify({ error: "API key missing organization context" }),
      {
        status: HttpStatus.FORBIDDEN,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      }
    );
  }

  const apiKeyId = auth.apiKeyId;
  // OAuth tokens carry a scope string; API keys have full access (undefined scope).
  const scope = auth.scope;

  // Mint the JWT that becomes the Mcp-Session-Id returned to the client.
  // Any pod can verify and reconstruct state from this token on future requests.
  const newSessionId = await createSessionToken({
    org: organizationId,
    key: apiKeyId,
    scope,
  });

  const internalApiBaseUrl = getInternalApiBaseUrl();
  const authHeader = request.headers.get("authorization") ?? "";
  const { transport, entry } = buildSession(
    newSessionId,
    organizationId,
    apiKeyId,
    scope,
    internalApiBaseUrl,
    authHeader
  );

  await entry.server.connect(transport);

  return applyRateLimitHeaders(
    await transport.handleRequest(ensureMcpAcceptHeader(request), {
      parsedBody: body,
    }),
    rateLimit
  );
}

export async function GET(request: Request): Promise<Response> {
  // Anonymous health probe: no session header means the caller is just
  // checking reachability (e.g. ERC-8004 indexer). Return minimal
  // server-info without touching auth or the SDK.
  const sessionId = request.headers.get("mcp-session-id");
  if (!sessionId) {
    const baseUrl = getBaseUrl(request);
    const resourceMetadataUrl = `${baseUrl}/.well-known/oauth-protected-resource`;
    return new Response(
      JSON.stringify({
        name: "keeperhub",
        version: "1.2.0",
        protocol: "mcp",
        status: "ok",
        authentication: {
          required: true,
          resource_metadata: resourceMetadataUrl,
        },
      }),
      {
        status: HttpStatus.OK,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          ...CORS_HEADERS,
        },
      }
    );
  }

  const auth = await authenticate(request);
  if (!auth.authenticated) {
    const reason = auth.error ?? "Unauthorized";
    logMcpEvent("mcp.auth.failed", { reason });
    if ((auth.statusCode ?? 401) === 401) {
      return unauthorizedResponse(request);
    }
    return new Response(JSON.stringify({ error: reason }), {
      status: auth.statusCode,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }

  const organizationId = auth.organizationId ?? "";
  const resolved = await resolveSession(
    sessionId,
    organizationId,
    auth.apiKeyId ?? "",
    request
  );
  if (!resolved.ok) {
    return buildSessionErrorResponse(resolved.code, {
      headers: CORS_HEADERS,
    });
  }

  const response = await resolved.transport.handleRequest(
    ensureMcpAcceptHeader(request)
  );
  return withRenewedSessionHeader(response, resolved.renewedSessionId);
}

export async function DELETE(request: Request): Promise<Response> {
  const auth = await authenticate(request);
  if (!auth.authenticated) {
    const reason = auth.error ?? "Unauthorized";
    logMcpEvent("mcp.auth.failed", { reason });
    if ((auth.statusCode ?? 401) === 401) {
      return unauthorizedResponse(request);
    }
    return new Response(JSON.stringify({ error: reason }), {
      status: auth.statusCode,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }

  const sessionId = request.headers.get("mcp-session-id");
  if (!sessionId) {
    // DELETE requires the client to echo back the Mcp-Session-Id from the
    // initialize response. Surface -32004 so clients distinguish "you
    // forgot the header" from "your session doesn't exist".
    return buildSessionErrorResponse("missing_session_id", {
      headers: CORS_HEADERS,
    });
  }

  const organizationId = auth.organizationId ?? "";

  // Verify ownership via JWT before touching anything in the local cache.
  // Accept expired JWTs so clients can clean up old sessions. Bind the `key`
  // claim to the authenticated caller so a leaked MCP_SESSION_SECRET cannot
  // forge deletion of another principal's session.
  const payload = await verifySessionToken(sessionId, { allowExpired: true });
  if (
    !payload ||
    payload.org !== organizationId ||
    payload.key !== (auth.apiKeyId ?? "")
  ) {
    return buildSessionErrorResponse("session_not_found", {
      headers: CORS_HEADERS,
    });
  }

  // Close and evict from local cache if present on this pod.
  const cached = getSession(sessionId);
  if (cached) {
    await cached.server.close();
    await cached.transport.close();
    deleteSession(sessionId);
  }

  return new Response(null, {
    status: HttpStatus.NO_CONTENT,
    headers: CORS_HEADERS,
  });
}
