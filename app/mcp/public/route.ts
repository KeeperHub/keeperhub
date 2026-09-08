import { HttpStatus } from "@/lib/http-status";
import "server-only";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { McpEventStore } from "@/lib/mcp/event-store";
import { getInternalApiBaseUrl } from "@/lib/mcp/internal-url";
import { logMcpEvent } from "@/lib/mcp/logging";
import { normalizeToolCallArguments } from "@/lib/mcp/normalize-tool-call-arguments";
import { SCOPE_MCP_PUBLIC } from "@/lib/mcp/oauth-scopes";
import { checkIpRateLimit, getClientIp } from "@/lib/mcp/rate-limit";
import { createMcpServer } from "@/lib/mcp/server";
import { buildSessionErrorResponse } from "@/lib/mcp/session-error";
import {
  createSessionToken,
  verifySessionTokenDetailed,
} from "@/lib/mcp/session-token";
import {
  deleteSession,
  getSession,
  type SessionEntry,
  setSession,
  touchSession,
} from "@/lib/mcp/sessions";
import {
  applyRateLimitHeaders,
  rateLimitHeaders,
} from "@/lib/rate-limit-headers";

export const dynamic = "force-dynamic";

// Anonymous marketplace surface. Unauthenticated callers (x402 agents, ERC-8004
// indexers, marketplace probers) can `initialize`, `tools/list`, and call the
// PUBLIC_TOOLS allowlist -- which proxies endpoints that are already public
// over HTTP. The authenticated org surface lives at /mcp and is never reachable
// from here: this route never reads Authorization, pins a non-empty org
// sentinel, and runs under the terminal `mcp:public` scope (registration is
// filtered to public tools in createMcpServer).
const ANON_ORG = "__anon_public__";
const ANON_KEY = "anon";

// Per-IP limits keyed on the real client IP (cf-connecting-ip). A `tools/call`
// gets a stricter bucket than discovery so anonymous execution can't be used to
// hammer the workflow executor; the underlying REST call route keeps its own
// IP/quota/concurrency limits as defense in depth.
const LIST_LIMIT = 60;
const CALL_LIMIT = 10;
const WINDOW_MS = 60_000;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Mcp-Session-Id, Mcp-Protocol-Version",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
} as const;

function jsonRpcError(
  status: number,
  code: number,
  message: string,
  extraHeaders: Record<string, string> = {}
): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        ...CORS_HEADERS,
        ...extraHeaders,
      },
    }
  );
}

function isInitializeBody(body: unknown): boolean {
  if (Array.isArray(body)) {
    return body.length > 0 && body.every((item) => isInitializeRequest(item));
  }
  return isInitializeRequest(body);
}

function isToolCallBody(body: unknown): boolean {
  const isCall = (item: unknown): boolean =>
    !!item &&
    typeof item === "object" &&
    (item as Record<string, unknown>).method === "tools/call";
  return Array.isArray(body) ? body.some(isCall) : isCall(body);
}

/**
 * Mirror of the /mcp buildSession, hardcoded to the anonymous identity. The
 * authHeader is ALWAYS the empty string, so even if a public tool handler hit
 * an org-scoped internal endpoint it would carry no credentials and the inner
 * route would reject it.
 */
function buildPublicSession(sessionId: string): {
  transport: WebStandardStreamableHTTPServerTransport;
  entry: SessionEntry;
} {
  const eventStore = new McpEventStore();
  const internalApiBaseUrl = getInternalApiBaseUrl();

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => sessionId,
    eventStore,
    onsessioninitialized: (sid) => setSession(sid, entry),
    onsessionclosed: (sid) => deleteSession(sid),
    enableJsonResponse: true,
  });

  const server = createMcpServer(internalApiBaseUrl, "", SCOPE_MCP_PUBLIC);

  const entry: SessionEntry = {
    transport,
    server,
    eventStore,
    organizationId: ANON_ORG,
    apiKeyId: ANON_KEY,
    scope: SCOPE_MCP_PUBLIC,
    createdAt: Date.now(),
    lastActivity: Date.now(),
  };

  return { transport, entry };
}

/** Patch the Accept header the MCP SDK requires (some clients omit SSE). */
function ensureMcpAcceptHeader(request: Request): Request {
  const accept = request.headers.get("accept") ?? "";
  if (
    accept.includes("application/json") &&
    accept.includes("text/event-stream")
  ) {
    return request;
  }
  const headers = new Headers(request.headers);
  headers.set("accept", "application/json, text/event-stream");
  // Rebuild from url+method with NO body: the early body parse already consumed
  // request.body, and the SDK transport gets the parsed value via parsedBody.
  // Constructing `new Request(request, ...)` from a used Request would throw.
  return new Request(request.url, { method: request.method, headers });
}

export function OPTIONS(): Response {
  return new Response(null, {
    status: HttpStatus.NO_CONTENT,
    headers: CORS_HEADERS,
  });
}

// Some marketplace probers issue a GET before POSTing. Mirror the /mcp health
// shape but advertise that this surface is anonymous (no OAuth required).
export function GET(request: Request): Response {
  if (request.headers.get("mcp-session-id")) {
    // JSON-only transport: no server-initiated SSE stream to resume here.
    return jsonRpcError(
      HttpStatus.METHOD_NOT_ALLOWED,
      -32_601,
      "Method not allowed"
    );
  }
  return new Response(
    JSON.stringify({
      name: "keeperhub",
      version: "1.2.0",
      protocol: "mcp",
      status: "ok",
      authentication: { required: false },
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

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  let bodyParsed = false;
  try {
    body = normalizeToolCallArguments(await request.json());
    bodyParsed = true;
  } catch {
    // handled below
  }

  if (!bodyParsed) {
    return jsonRpcError(HttpStatus.BAD_REQUEST, -32_700, "Invalid JSON body");
  }

  // Per-IP rate limiting on the real client IP (never the org, which is the
  // shared anon sentinel here).
  const ip = getClientIp(request);
  const listGate = checkIpRateLimit(`mcp-public:${ip}`, LIST_LIMIT, WINDOW_MS);
  if (!listGate.allowed) {
    return jsonRpcError(
      HttpStatus.TOO_MANY_REQUESTS,
      -32_029,
      "Rate limit exceeded",
      rateLimitHeaders(listGate)
    );
  }
  // The call bucket is the binding limit for a tools/call, so its state is what
  // success-path headers must advertise; the list bucket binds everything else.
  let effectiveGate = listGate;
  if (isToolCallBody(body)) {
    const callGate = checkIpRateLimit(
      `mcp-public-call:${ip}`,
      CALL_LIMIT,
      WINDOW_MS
    );
    if (!callGate.allowed) {
      return jsonRpcError(
        HttpStatus.TOO_MANY_REQUESTS,
        -32_029,
        "Rate limit exceeded",
        rateLimitHeaders(callGate)
      );
    }
    effectiveGate = callGate;
  }

  const sessionId = request.headers.get("mcp-session-id");

  if (sessionId) {
    const resolved = await resolvePublicSession(sessionId);
    if (!resolved.ok) {
      return buildSessionErrorResponse(resolved.code, {
        headers: CORS_HEADERS,
      });
    }
    return applyRateLimitHeaders(
      await resolved.transport.handleRequest(ensureMcpAcceptHeader(request), {
        parsedBody: body,
      }),
      effectiveGate
    );
  }

  if (!isInitializeBody(body)) {
    return buildSessionErrorResponse("session_not_initialized", {
      headers: CORS_HEADERS,
    });
  }

  const newSessionId = await createSessionToken({
    org: ANON_ORG,
    key: ANON_KEY,
    scope: SCOPE_MCP_PUBLIC,
  });
  const { transport, entry } = buildPublicSession(newSessionId);
  await entry.server.connect(transport);
  logMcpEvent("mcp.public.session.created", { ip });

  return applyRateLimitHeaders(
    await transport.handleRequest(ensureMcpAcceptHeader(request), {
      parsedBody: body,
    }),
    effectiveGate
  );
}

type ResolveResult =
  | { ok: true; transport: WebStandardStreamableHTTPServerTransport }
  | { ok: false; code: "session_not_found" | "session_expired" };

async function resolvePublicSession(sessionId: string): Promise<ResolveResult> {
  const cached = getSession(sessionId);
  if (cached) {
    // A session minted by the authenticated /mcp route can never be replayed
    // here: it carries a real org and a non-public scope.
    if (
      cached.organizationId !== ANON_ORG ||
      cached.scope !== SCOPE_MCP_PUBLIC
    ) {
      return { ok: false, code: "session_not_found" };
    }
    touchSession(sessionId);
    return { ok: true, transport: cached.transport };
  }

  const result = await verifySessionTokenDetailed(sessionId);
  if (!result.payload) {
    const expiredBeyondRenewal =
      "reason" in result &&
      (result.reason === "too_old" ||
        result.reason === "max_lifetime_exceeded");
    return {
      ok: false,
      code: expiredBeyondRenewal ? "session_expired" : "session_not_found",
    };
  }
  if (
    result.payload.org !== ANON_ORG ||
    result.payload.scope !== SCOPE_MCP_PUBLIC
  ) {
    return { ok: false, code: "session_not_found" };
  }

  const { transport, entry } = buildPublicSession(sessionId);
  await entry.server.connect(transport);
  const reconstructed = transport as unknown as {
    _initialized: boolean;
    sessionId: string;
  };
  reconstructed._initialized = true;
  reconstructed.sessionId = sessionId;
  setSession(sessionId, entry);
  return { ok: true, transport };
}
