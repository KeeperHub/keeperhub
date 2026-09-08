import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { McpEventStore } from "@/lib/mcp/event-store";
import { logMcpEvent } from "@/lib/mcp/logging";
import { SESSION_TTL_SECONDS } from "@/lib/mcp/session-token";

export const SESSION_TTL_MS = SESSION_TTL_SECONDS * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// Hard caps on local cache size. Each SessionEntry holds a Transport +
// McpServer + EventStore (~MB scale), so without a ceiling a single
// misbehaving client can OOM the pod inside the 24h TTL window. Per-key
// cap defends against one apiKeyId pinning the cache; global cap is the
// backstop against fan-out across many keys.
export const MAX_SESSIONS_TOTAL = Math.max(
  1,
  Number(process.env.MCP_MAX_LOCAL_SESSIONS) || 350
);
export const MAX_SESSIONS_PER_KEY = Math.max(
  1,
  Number(process.env.MCP_MAX_SESSIONS_PER_KEY) || 5
);

export type SessionEntry = {
  transport: WebStandardStreamableHTTPServerTransport;
  server: McpServer;
  eventStore: McpEventStore;
  organizationId: string;
  apiKeyId: string;
  scope?: string;
  createdAt: number;
  lastActivity: number;
};

// Local in-process cache. The JWT session token is the source of truth.
// This cache is a performance optimisation: same-pod requests skip reconstruction.
// Cross-pod and post-restart requests fall back to JWT verification.
const localCache = new Map<string, SessionEntry>();

// Sidecar index: apiKeyId -> ordered set of sessionIds (insertion = LRU order).
// Lets setSession enforce MAX_SESSIONS_PER_KEY without scanning localCache.
const sessionsByKey = new Map<string, Set<string>>();

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

export function getSession(sessionId: string): SessionEntry | undefined {
  return localCache.get(sessionId);
}

export function setSession(sessionId: string, entry: SessionEntry): void {
  // Close any prior entry under the same sessionId before we overwrite, so
  // the old transport and server are released instead of leaked. In
  // production same sessionId implies same apiKeyId (both derive from the
  // JWT), but if they ever diverge, also drop the orphan from the old
  // key's bucket.
  const previousEntry = localCache.get(sessionId);
  if (previousEntry !== undefined && previousEntry !== entry) {
    previousEntry.server.close().catch(() => undefined);
    previousEntry.transport.close().catch(() => undefined);
    if (previousEntry.apiKeyId !== entry.apiKeyId) {
      removeFromKeyBucket(previousEntry.apiKeyId, sessionId);
    }
  }

  const existingBucket = sessionsByKey.get(entry.apiKeyId);
  if (
    existingBucket !== undefined &&
    !existingBucket.has(sessionId) &&
    existingBucket.size >= MAX_SESSIONS_PER_KEY
  ) {
    const oldestForKey = existingBucket.values().next().value;
    if (oldestForKey !== undefined) {
      evict(oldestForKey, "per_key_cap");
    }
  }

  if (!localCache.has(sessionId) && localCache.size >= MAX_SESSIONS_TOTAL) {
    const oldestOverall = localCache.keys().next().value;
    if (oldestOverall !== undefined) {
      evict(oldestOverall, "global_cap");
    }
  }

  localCache.set(sessionId, entry);
  const bucket = sessionsByKey.get(entry.apiKeyId) ?? new Set<string>();
  bucket.delete(sessionId);
  bucket.add(sessionId);
  sessionsByKey.set(entry.apiKeyId, bucket);

  logMcpEvent("mcp.session.created", {
    sessionId,
    orgId: entry.organizationId,
  });
}

export function deleteSession(sessionId: string): void {
  const entry = localCache.get(sessionId);
  localCache.delete(sessionId);
  if (entry !== undefined) {
    removeFromKeyBucket(entry.apiKeyId, sessionId);
  }
  logMcpEvent("mcp.session.terminated", {
    sessionId,
    orgId: entry?.organizationId,
  });
}

export function touchSession(sessionId: string): void {
  const entry = localCache.get(sessionId);
  if (entry === undefined) {
    return;
  }
  entry.lastActivity = Date.now();
  // LRU promote: re-insert at the tail of both indexes so active sessions
  // are not picked as eviction candidates.
  localCache.delete(sessionId);
  localCache.set(sessionId, entry);
  const bucket = sessionsByKey.get(entry.apiKeyId);
  if (bucket !== undefined) {
    bucket.delete(sessionId);
    bucket.add(sessionId);
  }
}

function removeFromKeyBucket(apiKeyId: string, sessionId: string): void {
  const bucket = sessionsByKey.get(apiKeyId);
  if (bucket === undefined) {
    return;
  }
  bucket.delete(sessionId);
  if (bucket.size === 0) {
    sessionsByKey.delete(apiKeyId);
  }
}

function evict(sessionId: string, reason: "per_key_cap" | "global_cap"): void {
  const entry = localCache.get(sessionId);
  if (entry === undefined) {
    return;
  }
  localCache.delete(sessionId);
  removeFromKeyBucket(entry.apiKeyId, sessionId);
  entry.server.close().catch(() => undefined);
  entry.transport.close().catch(() => undefined);
  logMcpEvent("mcp.session.evicted", {
    sessionId,
    orgId: entry.organizationId,
    apiKeyId: entry.apiKeyId,
    reason,
  });
}

export function cleanupExpiredSessions(): void {
  const now = Date.now();
  for (const [sessionId, entry] of localCache) {
    if (now - entry.lastActivity > SESSION_TTL_MS) {
      localCache.delete(sessionId);
      removeFromKeyBucket(entry.apiKeyId, sessionId);
      entry.server.close().catch(() => undefined);
      entry.transport.close().catch(() => undefined);
      logMcpEvent("mcp.session.expired", {
        sessionId,
        orgId: entry.organizationId,
      });
    }
  }
}

export function getSessionCount(): number {
  return localCache.size;
}

export function getSessionStats(): {
  size: number;
  maxTotal: number;
  maxPerKey: number;
  keyCount: number;
} {
  return {
    size: localCache.size,
    maxTotal: MAX_SESSIONS_TOTAL,
    maxPerKey: MAX_SESSIONS_PER_KEY,
    keyCount: sessionsByKey.size,
  };
}

// Test-only: clears all in-process state. Production code must not call this.
export function resetSessionCacheForTesting(): void {
  localCache.clear();
  sessionsByKey.clear();
}

export function startCleanupInterval(): void {
  if (cleanupTimer !== null) {
    clearInterval(cleanupTimer);
  }
  cleanupTimer = setInterval(cleanupExpiredSessions, CLEANUP_INTERVAL_MS);
  if (
    cleanupTimer !== null &&
    typeof cleanupTimer === "object" &&
    "unref" in cleanupTimer
  ) {
    cleanupTimer.unref();
  }
}

export function stopCleanupInterval(): void {
  if (cleanupTimer !== null) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}
