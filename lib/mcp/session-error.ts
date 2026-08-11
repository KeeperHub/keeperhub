/**
 * MCP session bootstrap error envelopes.
 *
 * KEEP-474: 5 hackathon teams reverse-engineered defensive parsers because
 * session bootstrap failures returned opaque 4xx/5xx with empty content.
 * The remedy is a stable JSON-RPC 2.0 error shape with documented codes and
 * a `data.hint` recovery string, so clients branch on `error.code` instead
 * of regex-matching the message.
 *
 * Error codes live in the JSON-RPC reserved server-defined range
 * (-32000 to -32099). `data.reason` is the stable machine-readable string;
 * `data.hint` tells the client how to recover.
 *
 * Bootstrap order clients MUST follow:
 *   1. POST /mcp with `initialize` request   -> response carries Mcp-Session-Id
 *   2. POST /mcp with `notifications/initialized`
 *   3. POST /mcp with `tools/list` or `tools/call`
 * Steps 2 and 3 MUST be sequential, not parallel.
 */

export type SessionErrorCode =
  | "session_not_found"
  | "session_expired"
  | "session_not_initialized"
  | "missing_session_id";

export type SessionErrorDescriptor = {
  jsonRpcCode: number;
  message: string;
  hint: string;
  httpStatus: number;
};

export const SESSION_ERROR_DESCRIPTORS: Record<
  SessionErrorCode,
  SessionErrorDescriptor
> = {
  session_not_found: {
    jsonRpcCode: -32_001,
    message: "Session not found",
    hint: "Re-initialize the MCP session: POST /mcp with an `initialize` request, then send `notifications/initialized` before any `tools/list` or `tools/call`.",
    httpStatus: 404,
  },
  session_expired: {
    jsonRpcCode: -32_002,
    message: "Session expired",
    hint: "Sessions slide on a 24h window. Re-run the `initialize` -> `notifications/initialized` bootstrap to obtain a fresh Mcp-Session-Id.",
    httpStatus: 404,
  },
  session_not_initialized: {
    jsonRpcCode: -32_003,
    message: "Session not initialized",
    hint: "Send `notifications/initialized` after `initialize` and BEFORE any `tools/list` or `tools/call`. These must be sequential, not parallel.",
    httpStatus: 400,
  },
  missing_session_id: {
    jsonRpcCode: -32_004,
    message: "Missing Mcp-Session-Id header",
    hint: "After `initialize`, the response carries an `Mcp-Session-Id` header. Echo it back on every subsequent request.",
    httpStatus: 400,
  },
};

export type SessionErrorEnvelope = {
  jsonrpc: "2.0";
  id: null;
  error: {
    code: number;
    message: string;
    data: { reason: SessionErrorCode | string; hint: string };
  };
};

export function buildSessionErrorEnvelope(code: string): SessionErrorEnvelope {
  const descriptor =
    SESSION_ERROR_DESCRIPTORS[code as SessionErrorCode] ??
    SESSION_ERROR_DESCRIPTORS.session_not_found;
  return {
    jsonrpc: "2.0",
    id: null,
    error: {
      code: descriptor.jsonRpcCode,
      message: descriptor.message,
      data: { reason: code, hint: descriptor.hint },
    },
  };
}

export function sessionErrorBody(code: string): string {
  return JSON.stringify(buildSessionErrorEnvelope(code));
}

/**
 * Build a full `Response` for a session bootstrap error.
 *
 * Picks the HTTP status from the descriptor so callsites stay consistent
 * with the JSON-RPC code (-32001/-32002 are 404, -32003/-32004 are 400).
 * Merges caller-supplied headers (typically CORS + Content-Type) into the
 * response so every MCP route emits the same envelope without duplicating
 * the body assembly.
 */
export function buildSessionErrorResponse(
  code: string,
  options?: { headers?: HeadersInit; statusOverride?: number }
): Response {
  const descriptor =
    SESSION_ERROR_DESCRIPTORS[code as SessionErrorCode] ??
    SESSION_ERROR_DESCRIPTORS.session_not_found;
  const headers = new Headers(options?.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return new Response(sessionErrorBody(code), {
    status: options?.statusOverride ?? descriptor.httpStatus,
    headers,
  });
}
