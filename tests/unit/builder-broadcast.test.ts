import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { mockSafeFetch, mockLogWarn } = vi.hoisted(() => ({
  mockSafeFetch: vi.fn(),
  mockLogWarn: vi.fn(),
}));

vi.mock("@/lib/safe-fetch", () => ({
  safeFetch: (...args: unknown[]) => mockSafeFetch(...args),
}));
vi.mock("@/lib/logging", () => ({
  logWarn: (...args: unknown[]) => mockLogWarn(...args),
}));

import { broadcastToBuilders } from "@/lib/web3/builder-broadcast";

const SIGNED_HEX = "0x02f8abcdef";
const HASH = `0x${"ab".repeat(32)}`;

function jsonReply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function refusedConnection(): Error {
  return Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:443"), {
      code: "ECONNREFUSED",
    }),
  });
}

async function listen(
  handler: Parameters<typeof createServer>[1]
): Promise<{ server: Server; url: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve())
  );
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}` };
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

describe("broadcastToBuilders", () => {
  beforeEach(() => {
    mockSafeFetch.mockReset();
    mockLogWarn.mockReset();
  });

  it("sends eth_sendRawTransaction with the signed bytes to every builder", async () => {
    mockSafeFetch.mockImplementation(() =>
      Promise.resolve(jsonReply({ jsonrpc: "2.0", id: 1, result: HASH }))
    );

    const results = await broadcastToBuilders(SIGNED_HEX, HASH, {
      titan: "https://titan.example",
      beaver: "https://beaver.example",
    });

    expect(results).toEqual([
      { name: "titan", accepted: true },
      { name: "beaver", accepted: true },
    ]);
    expect(mockSafeFetch).toHaveBeenCalledTimes(2);
    const [url, init] = mockSafeFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://titan.example");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    expect(JSON.parse(init.body as string)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_sendRawTransaction",
      params: [SIGNED_HEX],
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it("accepts the hash in any case, and a builder that already has the transaction", async () => {
    mockSafeFetch
      .mockResolvedValueOnce(
        jsonReply({ jsonrpc: "2.0", id: 1, result: HASH.toUpperCase() })
      )
      .mockResolvedValueOnce(
        jsonReply({
          jsonrpc: "2.0",
          id: 1,
          error: { message: "already known" },
        })
      );

    const results = await broadcastToBuilders(SIGNED_HEX, HASH, {
      titan: "https://titan.example",
      beaver: "https://beaver.example",
    });

    expect(results).toEqual([
      { name: "titan", accepted: true },
      { name: "beaver", accepted: true },
    ]);
  });

  it("reads an answer naming another hash as unclear, never as accepted", async () => {
    mockSafeFetch.mockResolvedValue(
      jsonReply({ jsonrpc: "2.0", id: 1, result: "0xtracking-id" })
    );

    const results = await broadcastToBuilders(SIGNED_HEX, HASH, {
      titan: "https://titan.example",
    });

    expect(results).toEqual([
      { name: "titan", accepted: null, error: "answered with another hash" },
    ]);
  });

  it("reports a refusal with URLs removed from the message", async () => {
    mockSafeFetch.mockResolvedValue(
      jsonReply({
        jsonrpc: "2.0",
        id: 1,
        error: { message: "rejected by https://internal.example/key123" },
      })
    );

    const results = await broadcastToBuilders(SIGNED_HEX, HASH, {
      titan: "https://titan.example",
    });

    expect(results[0]?.accepted).toBe(false);
    expect(results[0]?.error).toContain("rejected by");
    expect(results[0]?.error).not.toContain("internal.example");
    expect(mockLogWarn).toHaveBeenCalledTimes(1);
  });

  it("reads an internal error as unclear: it may have taken the bytes", async () => {
    mockSafeFetch.mockResolvedValue(
      jsonReply({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32_603, message: "internal error" },
      })
    );

    const results = await broadcastToBuilders(SIGNED_HEX, HASH, {
      titan: "https://titan.example",
    });

    expect(results).toEqual([
      { name: "titan", accepted: null, error: "internal error" },
    ]);
  });

  it("never throws: a timeout is unclear, a refused connection is a refusal", async () => {
    mockSafeFetch
      .mockRejectedValueOnce(
        new DOMException(
          "The operation was aborted due to timeout",
          "TimeoutError"
        )
      )
      .mockRejectedValueOnce(refusedConnection())
      .mockResolvedValueOnce(
        jsonReply({ jsonrpc: "2.0", id: 1, result: HASH })
      );

    const results = await broadcastToBuilders(SIGNED_HEX, HASH, {
      slow: "https://slow.example",
      down: "https://down.example",
      fast: "https://fast.example",
    });

    expect(results).toEqual([
      {
        name: "slow",
        accepted: null,
        error: "The operation was aborted due to timeout",
      },
      {
        name: "down",
        accepted: false,
        error: "fetch failed: connect ECONNREFUSED 10.0.0.1:443",
      },
      { name: "fast", accepted: true },
    ]);
  });

  it.each([
    [503, "not json", null, "HTTP 503"],
    [502, JSON.stringify({ error: { message: "nope" } }), null, "HTTP 502"],
    [408, "", null, "HTTP 408"],
    // A bare 4xx may come from a CDN or WAF that read the signed bytes.
    [400, "bad request", null, "HTTP 400"],
    [403, "<html>forbidden</html>", null, "HTTP 403"],
    [429, "", null, "HTTP 429"],
    [
      400,
      JSON.stringify({ error: { code: -32_000, message: "invalid sender" } }),
      false,
      "invalid sender",
    ],
    [200, "<html>gateway</html>", null, "unreadable answer"],
  ] as const)(
    "reads HTTP %i with body %j as accepted=%s",
    async (status, body, accepted, error) => {
      mockSafeFetch.mockResolvedValue(new Response(body, { status }));

      const results = await broadcastToBuilders(SIGNED_HEX, HASH, {
        titan: "https://titan.example",
      });

      expect(results).toEqual([{ name: "titan", accepted, error }]);
    }
  );

  it("never re-sends the signed bytes to a redirect target (a real 307)", async () => {
    const { fetch } = await import("undici");
    mockSafeFetch.mockImplementation(
      (url: string, init: RequestInit & { plugin?: string }) => {
        const { plugin: _plugin, ...rest } = init;
        return fetch(url, rest as Parameters<typeof fetch>[1]);
      }
    );
    const targetHits: string[] = [];
    const target = await listen((req, res) => {
      targetHits.push(req.method ?? "");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: HASH }));
    });
    const builderHits: string[] = [];
    const builder = await listen((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        builderHits.push(body);
        res.statusCode = 307;
        res.setHeader("location", target.url);
        res.end();
      });
    });

    try {
      const results = await broadcastToBuilders(SIGNED_HEX, HASH, {
        titan: builder.url,
      });

      expect(results).toEqual([
        { name: "titan", accepted: null, error: "redirect not followed" },
      ]);
      expect(builderHits).toHaveLength(1);
      expect(JSON.parse(builderHits[0] ?? "{}").params).toEqual([SIGNED_HEX]);
      expect(targetHits).toEqual([]);
    } finally {
      await close(builder.server);
      await close(target.server);
    }
  });
});
