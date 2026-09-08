import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpEventStore } from "@/lib/mcp/event-store";
import type { SessionEntry } from "@/lib/mcp/sessions";

type SessionsModule = typeof import("@/lib/mcp/sessions");

type CloseSpies = {
  transportClose: ReturnType<typeof vi.fn>;
  serverClose: ReturnType<typeof vi.fn>;
};

function makeEntry(
  organizationId: string,
  apiKeyId: string,
  spies?: CloseSpies
): SessionEntry {
  const transportClose =
    spies?.transportClose ?? vi.fn(() => Promise.resolve());
  const serverClose = spies?.serverClose ?? vi.fn(() => Promise.resolve());
  return {
    transport: {
      close: transportClose,
    } as unknown as WebStandardStreamableHTTPServerTransport,
    server: { close: serverClose } as unknown as McpServer,
    eventStore: {} as unknown as McpEventStore,
    organizationId,
    apiKeyId,
    createdAt: Date.now(),
    lastActivity: Date.now(),
  };
}

async function loadSessions(env: {
  perKey: number;
  total: number;
}): Promise<SessionsModule> {
  vi.stubEnv("MCP_MAX_SESSIONS_PER_KEY", String(env.perKey));
  vi.stubEnv("MCP_MAX_LOCAL_SESSIONS", String(env.total));
  vi.resetModules();
  return await import("@/lib/mcp/sessions");
}

describe("mcp/sessions cache caps", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("evicts the oldest session for a key once its bucket is full", async () => {
    const sessions = await loadSessions({ perKey: 3, total: 100 });
    sessions.resetSessionCacheForTesting();

    sessions.setSession("s1", makeEntry("org-a", "key-A"));
    sessions.setSession("s2", makeEntry("org-a", "key-A"));
    sessions.setSession("s3", makeEntry("org-a", "key-A"));
    sessions.setSession("s4", makeEntry("org-a", "key-A"));

    expect(sessions.getSession("s1")).toBeUndefined();
    expect(sessions.getSession("s2")).toBeDefined();
    expect(sessions.getSession("s3")).toBeDefined();
    expect(sessions.getSession("s4")).toBeDefined();
    expect(sessions.getSessionStats().size).toBe(3);
  });

  it("does not touch other keys' sessions when one key hits its per-key cap", async () => {
    const sessions = await loadSessions({ perKey: 2, total: 100 });
    sessions.resetSessionCacheForTesting();

    sessions.setSession("a1", makeEntry("org-a", "key-A"));
    sessions.setSession("b1", makeEntry("org-b", "key-B"));
    sessions.setSession("a2", makeEntry("org-a", "key-A"));
    sessions.setSession("a3", makeEntry("org-a", "key-A"));

    expect(sessions.getSession("a1")).toBeUndefined();
    expect(sessions.getSession("a2")).toBeDefined();
    expect(sessions.getSession("a3")).toBeDefined();
    expect(sessions.getSession("b1")).toBeDefined();
  });

  it("evicts the global LRU when the total cap is reached across many keys", async () => {
    const sessions = await loadSessions({ perKey: 100, total: 3 });
    sessions.resetSessionCacheForTesting();

    sessions.setSession("s1", makeEntry("org-a", "key-A"));
    sessions.setSession("s2", makeEntry("org-b", "key-B"));
    sessions.setSession("s3", makeEntry("org-c", "key-C"));
    sessions.setSession("s4", makeEntry("org-d", "key-D"));

    expect(sessions.getSession("s1")).toBeUndefined();
    expect(sessions.getSession("s2")).toBeDefined();
    expect(sessions.getSession("s3")).toBeDefined();
    expect(sessions.getSession("s4")).toBeDefined();
    expect(sessions.getSessionStats().size).toBe(3);
  });

  it("touchSession promotes the entry so it survives the next eviction", async () => {
    const sessions = await loadSessions({ perKey: 100, total: 3 });
    sessions.resetSessionCacheForTesting();

    sessions.setSession("s1", makeEntry("org-a", "key-A"));
    sessions.setSession("s2", makeEntry("org-b", "key-B"));
    sessions.setSession("s3", makeEntry("org-c", "key-C"));

    sessions.touchSession("s1");

    sessions.setSession("s4", makeEntry("org-d", "key-D"));

    expect(sessions.getSession("s1")).toBeDefined();
    expect(sessions.getSession("s2")).toBeUndefined();
    expect(sessions.getSession("s3")).toBeDefined();
    expect(sessions.getSession("s4")).toBeDefined();
  });

  it("re-setting an existing sessionId does not evict and does not double-count", async () => {
    const sessions = await loadSessions({ perKey: 2, total: 100 });
    sessions.resetSessionCacheForTesting();

    sessions.setSession("s1", makeEntry("org-a", "key-A"));
    sessions.setSession("s2", makeEntry("org-a", "key-A"));
    sessions.setSession("s1", makeEntry("org-a", "key-A"));

    expect(sessions.getSession("s1")).toBeDefined();
    expect(sessions.getSession("s2")).toBeDefined();
    expect(sessions.getSessionStats().size).toBe(2);
  });

  it("deleteSession clears both the main map and the per-key bucket", async () => {
    const sessions = await loadSessions({ perKey: 5, total: 100 });
    sessions.resetSessionCacheForTesting();

    sessions.setSession("s1", makeEntry("org-a", "key-A"));
    sessions.setSession("s2", makeEntry("org-a", "key-A"));

    sessions.deleteSession("s1");
    expect(sessions.getSession("s1")).toBeUndefined();
    expect(sessions.getSessionStats().size).toBe(1);
    expect(sessions.getSessionStats().keyCount).toBe(1);

    sessions.deleteSession("s2");
    expect(sessions.getSessionStats().size).toBe(0);
    expect(sessions.getSessionStats().keyCount).toBe(0);
  });

  it("eviction closes the underlying transport and server", async () => {
    const sessions = await loadSessions({ perKey: 1, total: 100 });
    sessions.resetSessionCacheForTesting();

    const spies: CloseSpies = {
      transportClose: vi.fn(() => Promise.resolve()),
      serverClose: vi.fn(() => Promise.resolve()),
    };
    sessions.setSession("s1", makeEntry("org-a", "key-A", spies));
    sessions.setSession("s2", makeEntry("org-a", "key-A"));

    expect(spies.transportClose).toHaveBeenCalledTimes(1);
    expect(spies.serverClose).toHaveBeenCalledTimes(1);
  });

  it("reports the configured caps via getSessionStats", async () => {
    const sessions = await loadSessions({ perKey: 7, total: 42 });

    expect(sessions.getSessionStats().maxPerKey).toBe(7);
    expect(sessions.getSessionStats().maxTotal).toBe(42);
  });

  it("re-setting an existing sessionId closes the previous transport and server", async () => {
    const sessions = await loadSessions({ perKey: 5, total: 100 });
    sessions.resetSessionCacheForTesting();

    const oldSpies: CloseSpies = {
      transportClose: vi.fn(() => Promise.resolve()),
      serverClose: vi.fn(() => Promise.resolve()),
    };
    sessions.setSession("s1", makeEntry("org-a", "key-A", oldSpies));
    sessions.setSession("s1", makeEntry("org-a", "key-A"));

    expect(oldSpies.transportClose).toHaveBeenCalledTimes(1);
    expect(oldSpies.serverClose).toHaveBeenCalledTimes(1);
    expect(sessions.getSession("s1")).toBeDefined();
    expect(sessions.getSessionStats().size).toBe(1);
    expect(sessions.getSessionStats().keyCount).toBe(1);
  });

  it("cleanupExpiredSessions removes entries from sessionsByKey too", async () => {
    const sessions = await loadSessions({ perKey: 5, total: 100 });
    sessions.resetSessionCacheForTesting();

    sessions.setSession("s1", makeEntry("org-a", "key-A"));
    sessions.setSession("s2", makeEntry("org-b", "key-B"));

    // Force both entries past TTL by mutating the stored references directly.
    const expiredAt = Date.now() - sessions.SESSION_TTL_MS - 1;
    const s1 = sessions.getSession("s1");
    const s2 = sessions.getSession("s2");
    if (s1 !== undefined) {
      s1.lastActivity = expiredAt;
    }
    if (s2 !== undefined) {
      s2.lastActivity = expiredAt;
    }

    sessions.cleanupExpiredSessions();

    expect(sessions.getSession("s1")).toBeUndefined();
    expect(sessions.getSession("s2")).toBeUndefined();
    expect(sessions.getSessionStats().size).toBe(0);
    expect(sessions.getSessionStats().keyCount).toBe(0);
  });

  it("per-key eviction does not cascade into a global eviction", async () => {
    // Both caps simultaneously satisfied, then a third add for the same
    // key should drop only s1 (per-key) and leave s2 (global) intact.
    const sessions = await loadSessions({ perKey: 2, total: 2 });
    sessions.resetSessionCacheForTesting();

    sessions.setSession("s1", makeEntry("org-a", "key-A"));
    sessions.setSession("s2", makeEntry("org-a", "key-A"));
    sessions.setSession("s3", makeEntry("org-a", "key-A"));

    expect(sessions.getSession("s1")).toBeUndefined();
    expect(sessions.getSession("s2")).toBeDefined();
    expect(sessions.getSession("s3")).toBeDefined();
    expect(sessions.getSessionStats().size).toBe(2);
  });
});
