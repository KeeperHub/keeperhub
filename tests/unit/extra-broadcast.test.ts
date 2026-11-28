import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/logging", () => ({ logWarn: vi.fn() }));
const { safeFetch } = vi.hoisted(() => ({ safeFetch: vi.fn() }));
vi.mock("@/lib/safe-fetch", () => ({ safeFetch }));

import {
  broadcastToExtraRpcs,
  extraRpcHasTransaction,
} from "@/lib/web3/extra-broadcast";

const HASH = `0x${"a".repeat(64)}`;

describe("extra URL deliveries", () => {
  beforeEach(() => {
    safeFetch.mockReset();
  });

  it("counts a 3xx as may-have-sent: the endpoint read the signed bytes", async () => {
    safeFetch.mockResolvedValue(
      Response.redirect("https://elsewhere.example", 307)
    );
    const { deliveries } = broadcastToExtraRpcs(
      ["https://extra.example"],
      "0x02",
      HASH,
      1
    );
    expect(await deliveries).toEqual(["unknown"]);
    expect(safeFetch).toHaveBeenCalledWith(
      "https://extra.example",
      expect.objectContaining({ redirect: "manual" })
    );
  });

  it.each([
    [403, "<html>forbidden</html>", "unknown"],
    [404, "", "unknown"],
    [429, "slow down", "unknown"],
    [
      400,
      JSON.stringify({ error: { code: -32_000, message: "invalid sender" } }),
      "refused",
    ],
    [
      400,
      JSON.stringify({ error: { code: -32_000, message: "already known" } }),
      "accepted",
    ],
  ] as const)(
    "reads HTTP %i with body %j as %s",
    async (status, body, delivery) => {
      // A bare 4xx may come from a CDN or WAF that read the signed bytes.
      safeFetch.mockResolvedValue(new Response(body, { status }));
      const { deliveries } = broadcastToExtraRpcs(
        ["https://extra.example"],
        "0x02",
        HASH,
        1
      );
      expect(await deliveries).toEqual([delivery]);
    }
  );

  it("counts a refused connection as never sent", async () => {
    safeFetch.mockRejectedValue(
      new TypeError("fetch failed", {
        cause: Object.assign(new Error("connect ECONNREFUSED"), {
          code: "ECONNREFUSED",
        }),
      })
    );
    const { deliveries } = broadcastToExtraRpcs(
      ["https://extra.example"],
      "0x02",
      HASH,
      1
    );
    expect(await deliveries).toEqual(["refused"]);
  });
});

describe("extraRpcHasTransaction", () => {
  beforeEach(() => {
    safeFetch.mockReset();
  });

  const answer = (body: unknown, status = 200): Response =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
    });

  it.each([
    [
      "the transaction",
      { jsonrpc: "2.0", id: 1, result: { hash: HASH } },
      true,
    ],
    ["a clear null", { jsonrpc: "2.0", id: 1, result: null }, false],
    [
      "a JSON-RPC error",
      { jsonrpc: "2.0", id: 1, error: { code: -32_601, message: "nope" } },
      undefined,
    ],
    ["no result field", { jsonrpc: "2.0", id: 1 }, undefined],
    ["a body that is not JSON", "<html>busy</html>", undefined],
  ] as const)("reads %s as %s", async (_name, body, expected) => {
    safeFetch.mockResolvedValue(answer(body));
    expect(await extraRpcHasTransaction("https://extra.example", HASH)).toBe(
      expected
    );
    expect(safeFetch).toHaveBeenCalledWith(
      "https://extra.example",
      expect.objectContaining({ redirect: "manual", method: "POST" })
    );
    const sent = JSON.parse(
      (safeFetch.mock.calls[0][1] as { body: string }).body
    );
    expect(sent).toMatchObject({
      method: "eth_getTransactionByHash",
      params: [HASH],
    });
  });

  it("reads a non-200 answer or a failed fetch as unclear", async () => {
    safeFetch.mockResolvedValue(answer({ result: null }, 503));
    expect(
      await extraRpcHasTransaction("https://extra.example", HASH)
    ).toBeUndefined();
    safeFetch.mockRejectedValue(new Error("timeout"));
    expect(
      await extraRpcHasTransaction("https://extra.example", HASH)
    ).toBeUndefined();
  });
});
