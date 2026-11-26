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

function jsonReply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("broadcastToBuilders", () => {
  beforeEach(() => {
    mockSafeFetch.mockReset();
    mockLogWarn.mockReset();
  });

  it("sends eth_sendRawTransaction with the signed bytes to every builder", async () => {
    mockSafeFetch.mockImplementation(() =>
      Promise.resolve(jsonReply({ jsonrpc: "2.0", id: 1, result: "0xhash" }))
    );

    const results = await broadcastToBuilders(SIGNED_HEX, {
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
    expect(JSON.parse(init.body as string)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_sendRawTransaction",
      params: [SIGNED_HEX],
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it("counts a builder that already has the transaction as accepted", async () => {
    mockSafeFetch.mockResolvedValue(
      jsonReply({ jsonrpc: "2.0", id: 1, error: { message: "already known" } })
    );

    const results = await broadcastToBuilders(SIGNED_HEX, {
      titan: "https://titan.example",
    });

    expect(results).toEqual([{ name: "titan", accepted: true }]);
  });

  it("reports a rejection with URLs removed from the message", async () => {
    mockSafeFetch.mockResolvedValue(
      jsonReply({
        jsonrpc: "2.0",
        id: 1,
        error: { message: "rejected by https://internal.example/key123" },
      })
    );

    const results = await broadcastToBuilders(SIGNED_HEX, {
      titan: "https://titan.example",
    });

    expect(results[0]?.accepted).toBe(false);
    expect(results[0]?.error).toContain("rejected by");
    expect(results[0]?.error).not.toContain("internal.example");
    expect(mockLogWarn).toHaveBeenCalledTimes(1);
  });

  it("never throws when a builder times out or is unreachable", async () => {
    mockSafeFetch
      .mockRejectedValueOnce(
        new Error("The operation was aborted due to timeout")
      )
      .mockResolvedValueOnce(
        jsonReply({ jsonrpc: "2.0", id: 1, result: "0xhash" })
      );

    const results = await broadcastToBuilders(SIGNED_HEX, {
      slow: "https://slow.example",
      fast: "https://fast.example",
    });

    expect(results).toEqual([
      {
        name: "slow",
        accepted: false,
        error: "The operation was aborted due to timeout",
      },
      { name: "fast", accepted: true },
    ]);
  });

  it("reports the HTTP status when the reply has no JSON-RPC error", async () => {
    mockSafeFetch.mockResolvedValue(jsonReply({}, 503));

    const results = await broadcastToBuilders(SIGNED_HEX, {
      titan: "https://titan.example",
    });

    expect(results).toEqual([
      { name: "titan", accepted: false, error: "HTTP 503" },
    ]);
  });
});
