/**
 * Bundle client: one body and one signature to every builder in parallel,
 * strict reading of each answer. The answers below are the ones builders gave
 * to live probes (an invalid one-byte tx, so nothing could be included).
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ethers } from "ethers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("@/lib/metrics", () => ({
  getMetricsCollector: () => ({
    incrementCounter: vi.fn(),
    recordLatency: vi.fn(),
    recordError: vi.fn(),
    setGauge: vi.fn(),
  }),
}));

const { mockSafeFetch, realSafeFetch } = vi.hoisted(() => ({
  mockSafeFetch: vi.fn(),
  realSafeFetch: { current: undefined as unknown },
}));

vi.mock("@/lib/safe-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/safe-fetch")>();
  realSafeFetch.current = actual.safeFetch;
  return { ...actual, safeFetch: mockSafeFetch };
});

import { type SafeFetchOptions, SsrfBlockedError } from "@/lib/safe-fetch";
import { sendBundle } from "@/lib/web3/bundles/client";

const searcher = new ethers.Wallet(`0x${"22".repeat(32)}`);
const BUNDLE_HASH = `0x${"ab".repeat(32)}`;
const SIGNED_TX = `0x02${"f8".repeat(60)}`;
const ALPHA = { name: "alpha", url: "https://alpha.builder.example" };

function json(status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function rpcError(message: string, code = -32_602): string {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code, message } });
}

// One builder's answer to a recorded response, without the builder name.
async function answerTo(response: Response): Promise<Record<string, unknown>> {
  mockSafeFetch.mockResolvedValueOnce(response);
  const [answer] = await sendBundle({
    builders: [ALPHA],
    signedTxs: [SIGNED_TX],
    targetBlock: 1,
    searcher,
  });
  const { builder, ...outcome } = answer;
  expect(builder).toBe("alpha");
  return outcome;
}

beforeEach(() => {
  mockSafeFetch.mockReset();
});

describe("builder answers (recorded probe answers)", () => {
  it.each([
    [
      "flashbots, unsigned: 200 + error",
      200,
      '{"jsonrpc":"2.0","error":{"code":-32600,"message":"signature is required"},"id":null}',
      { delivery: "refused", error: "signature is required" },
    ],
    [
      "flashbots, signed: 200 + error",
      200,
      '{"jsonrpc":"2.0","error":{"code":-32600,"message":"incorrect request","data":null},"id":1}',
      { delivery: "refused", error: "incorrect request" },
    ],
    [
      "flashbots, bad signature: 403 + error",
      403,
      '{"jsonrpc":"2.0","error":{"code":-32025,"message":"invalid flashbots signature"},"id":null}',
      { delivery: "refused", error: "invalid flashbots signature" },
    ],
    [
      "beaverbuild: 400 + error",
      400,
      '{"error":{"code":-32600,"message":"Unable to decode a tx in your bundle."},"id":1,"jsonrpc":"2.0"}',
      { delivery: "refused", error: "Unable to decode a tx in your bundle." },
    ],
    [
      "buildernet, signed: 400 + error",
      400,
      '{"id":1,"jsonrpc":"2.0","error":{"code":-32602,"message":"Invalid params"}}',
      { delivery: "refused", error: "Invalid params" },
    ],
    [
      "buildernet, unsigned: 400 + internal error code reads as unknown",
      400,
      '{"id":null,"jsonrpc":"2.0","error":{"code":-32603,"message":"Invalid signature"}}',
      { delivery: "unknown", error: "Invalid signature" },
    ],
    [
      "titan: 200 + error",
      200,
      '{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"rlp offset overflow"}}',
      { delivery: "refused", error: "rlp offset overflow" },
    ],
    [
      "quasar, bad signature: 200 + error",
      200,
      '{"jsonrpc":"2.0","id":1,"error":{"code":-32001,"message":"Unauthorized: Invalid X-Flashbots-Signature"}}',
      {
        delivery: "refused",
        error: "Unauthorized: Invalid X-Flashbots-Signature",
      },
    ],
    [
      "btcs: 200 + error",
      200,
      '{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"Failed to decode transaction, idx: 0, error: Failed to decode transaction, error: input too short"}}',
      {
        delivery: "refused",
        error:
          "Failed to decode transaction, idx: 0, error: Failed to decode transaction, error: input too short",
      },
    ],
    [
      "eureka, signed: 200 + error with data",
      200,
      '{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"failed to decode bundle","data":{"field":"txs[0]","kind":"invalid_transaction","reason":"transaction bytes are not a valid signed transaction"}}}',
      { delivery: "refused", error: "failed to decode bundle" },
    ],
    [
      "eureka, bad signature: 200 + error",
      200,
      '{"error":{"code":-32001,"message":"invalid signature: invalid parity: 17"},"id":1,"jsonrpc":"2.0"}',
      { delivery: "refused", error: "invalid signature: invalid parity: 17" },
    ],
    [
      "bloxroute, no account: 401 + error",
      401,
      '{"id":0,"error":{"code":-32004,"message":"Invalid account ID","data":"auth header cannot be empty"},"jsonrpc":"2.0"}',
      { delivery: "refused", error: "Invalid account ID" },
    ],
    [
      "gigabuilder: result null to anything",
      200,
      '{"jsonrpc":"2.0","result":null,"id":1}',
      { delivery: "unknown", error: "no result" },
    ],
  ])("%s", async (_label, status, text, expected) => {
    expect(await answerTo(json(status, text))).toEqual(expected);
  });
});

describe("builder answers (errors that may follow a forward)", () => {
  it.each([
    ["internal error code", rpcError("boom", -32_603)],
    ["internal error message", rpcError("Internal error", -32_000)],
    ["timed out", rpcError("upstream request timed out", -32_000)],
    ["timeout", rpcError("simulation timeout", -32_000)],
    ["deadline exceeded", rpcError("context deadline exceeded", -32_000)],
  ])("%s on 200 is unknown", async (_label, text) => {
    expect((await answerTo(json(200, text))).delivery).toBe("unknown");
  });

  it("reads a bare string error as a refusal with its text", async () => {
    expect(await answerTo(json(200, '{"error":"bundle too old"}'))).toEqual({
      delivery: "refused",
      error: "bundle too old",
    });
  });
  it("reads a duplicate bundle as accepted: the builder holds it", async () => {
    expect(
      (await answerTo(json(200, rpcError("bundle already known", -32_000))))
        .delivery
    ).toBe("accepted");
  });

  it.each([
    ["a hash string", BUNDLE_HASH],
    ["an object with a bundle hash", { bundleHash: BUNDLE_HASH }],
  ])(
    "lets %s win over an error object: accepted holds the nonce",
    async (_label, result) => {
      const body = {
        result,
        error: { code: -32_000, message: "bundle rejected" },
      };
      expect(await answerTo(json(200, body))).toEqual({
        delivery: "accepted",
        bundleHash: BUNDLE_HASH,
      });
    }
  );

  it("lets an error object decide beside a result that is not a valid hash", async () => {
    const body = {
      result: "0x12",
      error: { code: -32_000, message: "bundle rejected" },
    };
    expect((await answerTo(json(200, body))).delivery).toBe("refused");
  });

  it("lets a valid result hash win over a falsy top-level error", async () => {
    const text = `{"error":"","result":"${BUNDLE_HASH}"}`;
    expect(await answerTo(json(200, text))).toEqual({
      delivery: "accepted",
      bundleHash: BUNDLE_HASH,
    });
  });
});

describe("builder answers (strict accept)", () => {
  const upper = `0X${"AB".repeat(32)}`;

  it.each([
    [
      "an object with a bundle hash",
      { result: { bundleHash: BUNDLE_HASH } },
      { delivery: "accepted", bundleHash: BUNDLE_HASH },
    ],
    [
      "an uppercase 0X bundle hash, kept in lowercase",
      { result: { bundleHash: upper } },
      { delivery: "accepted", bundleHash: BUNDLE_HASH },
    ],
    [
      "a bare hash string",
      { result: upper },
      { delivery: "accepted", bundleHash: BUNDLE_HASH },
    ],
    [
      "a malformed bundle hash (not kept)",
      { result: { bundleHash: "0x1234<script>" } },
      { delivery: "accepted" },
    ],
    ["an empty object", { result: {} }, { delivery: "accepted" }],
    [
      "a false top-level error beside a result",
      { error: false, result: { bundleHash: BUNDLE_HASH } },
      { delivery: "accepted", bundleHash: BUNDLE_HASH },
    ],
  ])("accepts %s", async (_label, body, expected) => {
    expect(await answerTo(json(200, body))).toEqual(expected);
  });

  it.each([
    ["false", false],
    ["an empty string", ""],
    ["zero", 0],
    ["true", true],
    ["a non-hash string", "bundle rejected"],
    ["a 31-byte hash", `0x${"ab".repeat(31)}`],
    ["an array", [BUNDLE_HASH]],
    ["an error-shaped object", { error: "x" }],
  ])("reads %s as unknown", async (_label, result) => {
    expect(
      await answerTo(json(200, { jsonrpc: "2.0", id: 1, result }))
    ).toEqual({ delivery: "unknown", error: "unexpected result" });
  });
});

describe("builder answers (HTTP shapes)", () => {
  it.each([
    [
      "non-JSON on 200",
      json(200, "<html>ok</html>"),
      { delivery: "unknown", error: "unreadable answer" },
    ],
    [
      "JSON array on 200",
      json(200, "[]"),
      { delivery: "unknown", error: "unreadable answer" },
    ],
    [
      "an empty 204",
      new Response(null, { status: 204 }),
      { delivery: "unknown", error: "unreadable answer" },
    ],
    [
      "502 with an error body",
      json(502, '{"jsonrpc":"2.0","error":{"message":"bad gateway"}}'),
      { delivery: "unknown", error: "HTTP 502" },
    ],
    ["408", json(408, ""), { delivery: "unknown", error: "HTTP 408" }],
    [
      "401 without JSON",
      json(401, "auth header cannot be empty"),
      { delivery: "refused", error: "HTTP 401" },
    ],
    [
      "404 with an empty error message",
      json(404, '{"error":{"code":1}}'),
      { delivery: "refused", error: "HTTP 404" },
    ],
    [
      "a 308 redirect",
      Response.redirect("https://elsewhere.example/", 308),
      { delivery: "unknown", error: "redirect not followed" },
    ],
    [
      "a 302 redirect",
      Response.redirect("https://elsewhere.example/", 302),
      { delivery: "unknown", error: "redirect not followed" },
    ],
  ])("%s", async (_label, response, expected) => {
    expect(await answerTo(response)).toEqual(expected);
  });

  it("treats a body over 16 KB as unknown on 2xx and refused on 4xx", async () => {
    const pad = "x".repeat(20_000);
    expect(
      await answerTo(json(200, { jsonrpc: "2.0", id: 1, result: { pad } }))
    ).toEqual({ delivery: "unknown", error: "unreadable answer" });
    expect(
      await answerTo(json(400, { error: { code: -32_602, message: pad } }))
    ).toEqual({ delivery: "refused", error: "HTTP 400" });
  });

  it("treats a body cut off mid-stream as unknown", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"result":'));
        controller.error(new Error("socket hang up"));
      },
    });
    expect(await answerTo(new Response(stream, { status: 200 }))).toEqual({
      delivery: "unknown",
      error: "unreadable answer",
    });
  });
});

describe("builder error text", () => {
  async function errorTextOf(message: string): Promise<string> {
    const outcome = await answerTo(json(200, { error: { message } }));
    return outcome.error as string;
  }

  it("removes URLs and long hex, keeps a hash, and turns a newline into a space", async () => {
    const hash = `0x${"cd".repeat(32)}`;
    expect(
      await errorTextOf(
        `tx ${SIGNED_TX} failed at https://rpc.example/key/abc for ${hash}\nretry`
      )
    ).toBe(`tx [redacted] failed at [redacted] for ${hash} retry`);
  });

  it("removes raw hex without 0x and uppercase 0X hex", async () => {
    expect(await errorTextOf(`bad tx ${"f8".repeat(80)} end`)).toBe(
      "bad tx [redacted] end"
    );
    expect(await errorTextOf(`raw ${"ab".repeat(32)}`)).toBe("raw [redacted]");
    expect(await errorTextOf(`bad 0X${"F8".repeat(40)}`)).toBe(
      "bad [redacted]"
    );
  });

  it("strips control and format characters, keeping word breaks", async () => {
    const bidi = String.fromCodePoint(0x20_2e);
    const esc = String.fromCodePoint(0x1b);
    const nul = String.fromCodePoint(0);
    const zeroWidth = String.fromCodePoint(0x20_0b);
    expect(
      await errorTextOf(
        `${bidi}evil ${esc}[31mred${esc}[0m${nul} a\tb\r\nc ${zeroWidth}d`
      )
    ).toBe("evil red a b c d");
  });

  it("still redacts long hex split by a zero-width character", async () => {
    const zeroWidth = String.fromCodePoint(0x20_0b);
    const split = `0x${"f8".repeat(30)}${zeroWidth}${"f8".repeat(30)}`;
    expect(await errorTextOf(`bad ${split}`)).toBe("bad [redacted]");
  });

  it("caps at 160 characters without splitting a surrogate pair", async () => {
    expect(await errorTextOf("x".repeat(500))).toHaveLength(160);
    const astral = String.fromCodePoint(0x1_f6_00);
    const text = await errorTextOf(`a${astral.repeat(300)}`);
    expect(Array.from(text)).toHaveLength(160);
    expect(text.endsWith("...")).toBe(true);
    expect(/\p{Cs}/u.test(text)).toBe(false);
  });
});

describe("sendBundle", () => {
  const builders = [
    ALPHA,
    { name: "beta", url: "https://beta.builder.example/rpc" },
    { name: "gamma", url: "https://gamma.builder.example" },
  ];

  it("posts the same signed body to every builder and returns each answer by name", async () => {
    mockSafeFetch.mockImplementation(async (url: string) => {
      if (url.includes("alpha")) {
        return json(200, {
          jsonrpc: "2.0",
          id: 1,
          result: { bundleHash: BUNDLE_HASH },
        });
      }
      if (url.includes("beta")) {
        return json(400, {
          error: { code: -32_602, message: "Invalid params" },
        });
      }
      return json(200, { jsonrpc: "2.0", id: 1, result: null });
    });

    const answers = await sendBundle({
      builders,
      signedTxs: [SIGNED_TX],
      targetBlock: 21_000_000,
      searcher,
    });

    expect(answers).toEqual([
      { builder: "alpha", delivery: "accepted", bundleHash: BUNDLE_HASH },
      { builder: "beta", delivery: "refused", error: "Invalid params" },
      { builder: "gamma", delivery: "unknown", error: "no result" },
    ]);

    expect(mockSafeFetch).toHaveBeenCalledTimes(3);
    const signatures = new Set<string>();
    for (const [, init] of mockSafeFetch.mock.calls) {
      expect(init.method).toBe("POST");
      expect(init.redirect).toBe("manual");
      expect(JSON.parse(init.body)).toEqual({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_sendBundle",
        params: [
          {
            txs: [SIGNED_TX],
            blockNumber: "0x1406f40",
            revertingTxHashes: [],
          },
        ],
      });
      const header = init.headers["x-flashbots-signature"] as string;
      const [address, signature] = header.split(":");
      expect(address).toBe(searcher.address);
      // Byte-identical: what was signed is what was sent.
      expect(ethers.verifyMessage(ethers.id(init.body), signature)).toBe(
        searcher.address
      );
      signatures.add(header);
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
    expect(signatures.size).toBe(1);
  });

  it("builds the exact eth_sendBundle bytes", async () => {
    mockSafeFetch.mockResolvedValue(json(200, { result: {} }));
    await sendBundle({
      builders: [ALPHA],
      signedTxs: ["0x02f8"],
      targetBlock: 16,
      searcher,
    });
    expect(mockSafeFetch.mock.calls[0][1].body).toBe(
      '{"jsonrpc":"2.0","id":1,"method":"eth_sendBundle","params":[{"txs":["0x02f8"],"blockNumber":"0x10","revertingTxHashes":[]}]}'
    );
  });

  it("classes a refused connection as refused and a timeout as unknown, without the URL", async () => {
    mockSafeFetch.mockImplementation(async (url: string) => {
      if (url.includes("alpha")) {
        throw Object.assign(new TypeError("fetch failed"), {
          cause: { code: "ENOTFOUND" },
        });
      }
      if (url.includes("beta")) {
        throw new SsrfBlockedError({
          hostname: "beta.builder.example",
          reason: "private-ip",
          message: "blocked",
        });
      }
      throw new DOMException(
        "The operation was aborted due to timeout",
        "TimeoutError"
      );
    });

    const answers = await sendBundle({
      builders,
      signedTxs: [SIGNED_TX],
      targetBlock: 1,
      searcher,
    });

    expect(answers.map((a) => a.delivery)).toEqual([
      "refused",
      "refused",
      "unknown",
    ]);
    expect(JSON.stringify(answers)).not.toContain("builder.example");
  });

  it("gives up on a slow builder after the timeout", async () => {
    mockSafeFetch.mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_, reject) => {
          init.signal.addEventListener("abort", () =>
            reject(init.signal.reason)
          );
        })
    );
    const started = Date.now();
    const [answer] = await sendBundle({
      builders: [ALPHA],
      signedTxs: [SIGNED_TX],
      targetBlock: 1,
      searcher,
      timeoutMs: 50,
    });
    expect(answer).toEqual({
      builder: "alpha",
      delivery: "unknown",
      error: "no answer in time",
    });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("never puts the searcher key or a builder URL in an answer", async () => {
    mockSafeFetch.mockImplementation(async () =>
      json(200, {
        error: {
          message: `bad tx ${SIGNED_TX} via https://alpha.builder.example/secret`,
        },
      })
    );
    const answers = await sendBundle({
      builders,
      signedTxs: [SIGNED_TX],
      targetBlock: 1,
      searcher,
    });
    const text = JSON.stringify(answers);
    expect(text).not.toContain("builder.example");
    expect(text).not.toContain("22".repeat(32));
    expect(text).not.toContain(SIGNED_TX);
  });
});

describe("sendBundle over the real transport", () => {
  let server: Server | undefined;

  afterEach(async () => {
    vi.unstubAllEnvs();
    await new Promise((resolve) => server?.close(resolve) ?? resolve(null));
    server = undefined;
  });

  it("does not follow a redirect with the signed body, and reads it as unknown (may have sent)", async () => {
    const hits: string[] = [];
    server = createServer((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      req.resume();
      req.on("end", () => {
        if (req.url === "/bundle") {
          res.writeHead(308, { location: "/elsewhere" });
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"result":{}}');
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    // Lets safeFetch reach the loopback test server.
    vi.stubEnv("SAFE_FETCH_SHADOW", "true");
    const real = realSafeFetch.current as (
      url: string,
      init: SafeFetchOptions
    ) => Promise<Response>;
    mockSafeFetch.mockImplementation(real);

    const [answer] = await sendBundle({
      builders: [{ name: "local", url: `http://127.0.0.1:${port}/bundle` }],
      signedTxs: [SIGNED_TX],
      targetBlock: 1,
      searcher,
    });

    expect(answer).toEqual({
      builder: "local",
      delivery: "unknown",
      error: "redirect not followed",
    });
    expect(hits).toEqual(["POST /bundle"]);
  });
});
