// Structured event logger for MCP operations.
// Emits canonical single-line JSON (via lib/log/core) so events are captured
// by the host log aggregator and queryable in Loki via `| json`. Do NOT log
// tokens, API keys, or other secrets.

import { emitLogLine } from "@/lib/log/core";

export function logMcpEvent(
  event: string,
  data: Record<string, unknown>
): void {
  emitLogLine("info", { msg: event, event, ...data });
}

/**
 * Wrap a tool handler with per-call logging.
 *
 * Emits three structured log events:
 *   mcp.tool.called     - at invocation start
 *   mcp.tool.completed  - on successful completion, includes duration_ms
 *   mcp.tool.error      - on thrown error, includes error message and duration_ms
 *
 * orgId is optional; when not available it can be correlated from session logs.
 */
export async function withToolLogging<T>(
  toolName: string,
  orgId: string | undefined,
  fn: () => T | Promise<T>
): Promise<T> {
  const startMs = Date.now();

  logMcpEvent("mcp.tool.called", {
    tool: toolName,
    org_id: orgId ?? null,
  });

  try {
    const result = await fn();
    const durationMs = Date.now() - startMs;

    logMcpEvent("mcp.tool.completed", {
      tool: toolName,
      org_id: orgId ?? null,
      duration_ms: durationMs,
      success: true,
    });

    return result;
  } catch (error) {
    const durationMs = Date.now() - startMs;
    const message = error instanceof Error ? error.message : String(error);

    logMcpEvent("mcp.tool.error", {
      tool: toolName,
      org_id: orgId ?? null,
      duration_ms: durationMs,
      success: false,
      error: message,
    });

    throw error;
  }
}
