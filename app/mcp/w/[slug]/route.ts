import { HttpStatus } from "@/lib/http-status";
import "server-only";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { type ApiKeyAuthResult, authenticateApiKey } from "@/lib/api-key-auth";
import { McpEventStore } from "@/lib/mcp/event-store";
import { getInternalApiBaseUrl } from "@/lib/mcp/internal-url";
import { getWorkflowListing } from "@/lib/mcp/listing";
import { logMcpEvent } from "@/lib/mcp/logging";
import { normalizeToolCallArguments } from "@/lib/mcp/normalize-tool-call-arguments";
import { authenticateOAuthToken } from "@/lib/mcp/oauth-auth";
import { checkMcpRateLimit, type RateLimitResult } from "@/lib/mcp/rate-limit";
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
import { createWorkflowMcpServer } from "@/lib/mcp/workflow-server";
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

startCleanupInterval();

const TRAILING_SLASH = /\/$/;

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
  // Rebuild from url+method with NO body: POST parses the body up front and
  // hands the transport the parsed value via parsedBody, and GET carries no
  // body at all. Constructing `new Request(request, ...)` from a used Request
  // would throw.
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

function unauthorizedResponse(request: Request): Response {
  const baseUrl = getBaseUrl(request);
  const resourceMetadataUrl = `${baseUrl}/.well-known/oauth-protected-resource`;
  const challenge = [
    'Bearer realm="OAuth"',
    `resource_metadata="${resourceMetadataUrl}"`,
    'error="invalid_token"',
    'error_description="Missing or invalid access token"',
  ].join(", ");
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

  return await authenticateApiKey(request);
}

function isInitializeRequestBody(body: unknown): boolean {
  if (Array.isArray(body)) {
    return body.some((item) => isInitializeRequest(item));
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

function buildSession(
  sessionId: string,
  organizationId: string,
  apiKeyId: string,
  scope: string | undefined,
  internalApiBaseUrl: string,
  authHeader: string,
  slug: string,
  listing: Parameters<typeof createWorkflowMcpServer>[0]["listing"]
): BuiltSession {
  const eventStore = new McpEventStore();

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

  const server = createWorkflowMcpServer({
    slug,
    listing,
    internalApiBaseUrl,
    authHeader,
    scope,
  });

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
  request: Request,
  slug: string,
  listing: Parameters<typeof createWorkflowMcpServer>[0]["listing"]
): Promise<ResolveSessionResult> {
  const cached = getSession(sessionId);
  if (cached) {
    if (cached.organizationId !== organizationId) {
      return { ok: false, code: "session_not_found" };
    }
    touchSession(sessionId);
    return { ok: true, transport: cached.transport };
  }

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

  if (result.payload.org !== organizationId) {
    return { ok: false, code: "session_not_found" };
  }

  logMcpEvent("mcp.session.reconstructed", {
    sessionId,
    orgId: organizationId,
  });

  const internalApiBaseUrl = getInternalApiBaseUrl();
  const authHeader = request.headers.get("authorization") ?? "";
  const { transport, entry } = buildSession(
    sessionId,
    organizationId,
    result.payload.key,
    result.payload.scope,
    internalApiBaseUrl,
    authHeader,
    slug,
    listing
  );

  await entry.server.connect(transport);

  const reconstructed = transport as unknown as {
    _initialized: boolean;
    sessionId: string;
  };
  reconstructed._initialized = true;
  reconstructed.sessionId = sessionId;

  setSession(sessionId, entry);

  let renewedSessionId: string | undefined;
  if (result.expired) {
    renewedSessionId = await createSessionToken({
      org: result.payload.org,
      key: result.payload.key,
      scope: result.payload.scope,
      original_iat: result.payload.original_iat ?? result.payload.iat,
    });

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

async function resolveListing(slug: string): Promise<
  | {
      ok: true;
      listing: Parameters<typeof createWorkflowMcpServer>[0]["listing"];
    }
  | { ok: false; response: Response }
> {
  // Authenticated per-workflow MCP server: intentionally uses the full,
  // nodes-bearing getWorkflowListing because createWorkflowMcpServer ->
  // detectListingTriggerType(listing.nodes) needs the workflow nodes for
  // trigger detection. The public/unauthenticated HTTP endpoint uses
  // getWorkflowListingPublic instead, which strips nodes.
  const result = await getWorkflowListing(slug);
  if (!(result.ok && result.listing.isListed)) {
    return {
      ok: false,
      response: new Response(JSON.stringify({ error: "Workflow not found" }), {
        status: HttpStatus.NOT_FOUND,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      }),
    };
  }
  return { ok: true, listing: result.listing };
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> }
): Promise<Response> {
  const { slug } = await params;

  const listingResult = await resolveListing(slug);
  if (!listingResult.ok) {
    return listingResult.response;
  }
  const { listing } = listingResult;

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

  const rateLimit = await checkMcpRateLimit(organizationId);
  if (!rateLimit.allowed) {
    logMcpEvent("mcp.rate.limited", { orgId: organizationId });
    return rateLimitResponse(rateLimit);
  }

  // Parsed here rather than in the initialize branch below so the session
  // path gets it too: that is where every tools/call on this route lands, and
  // an `arguments: null` handed straight to the SDK surfaces as an opaque
  // -32603. Consuming request.body means every transport call from here on
  // must pass parsedBody.
  let body: unknown;
  try {
    body = normalizeToolCallArguments(await request.json());
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: HttpStatus.BAD_REQUEST,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }

  const sessionId = request.headers.get("mcp-session-id");

  if (sessionId) {
    const resolved = await resolveSession(
      sessionId,
      organizationId,
      request,
      slug,
      listing
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
    // No session header AND not an `initialize` request: surface -32003 so
    // clients run the documented `initialize` -> `notifications/initialized`
    // bootstrap before retrying. Mirrors the wire shape from /mcp.
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
  const scope = auth.scope;

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
    authHeader,
    slug,
    listing
  );

  await entry.server.connect(transport);

  return applyRateLimitHeaders(
    await transport.handleRequest(ensureMcpAcceptHeader(request), {
      parsedBody: body,
    }),
    rateLimit
  );
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> }
): Promise<Response> {
  const { slug } = await params;

  const listingResult = await resolveListing(slug);
  if (!listingResult.ok) {
    return listingResult.response;
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

  const sessionId = request.headers.get("mcp-session-id");
  if (!sessionId) {
    return buildSessionErrorResponse("missing_session_id", {
      headers: CORS_HEADERS,
    });
  }

  const organizationId = auth.organizationId ?? "";
  const resolved = await resolveSession(
    sessionId,
    organizationId,
    request,
    slug,
    listingResult.listing
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

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ slug: string }> }
): Promise<Response> {
  const { slug } = await params;

  const listingResult = await resolveListing(slug);
  if (!listingResult.ok) {
    return listingResult.response;
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

  const sessionId = request.headers.get("mcp-session-id");
  if (!sessionId) {
    return buildSessionErrorResponse("missing_session_id", {
      headers: CORS_HEADERS,
    });
  }

  const organizationId = auth.organizationId ?? "";

  const payload = await verifySessionToken(sessionId, { allowExpired: true });
  if (!payload || payload.org !== organizationId) {
    return buildSessionErrorResponse("session_not_found", {
      headers: CORS_HEADERS,
    });
  }

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
