import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { FetchRequest } from "ethers";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
// The SSRF guard would refuse 127.0.0.1; undici's own fetch keeps the redirect handling under test.
vi.mock("@/lib/safe-fetch", async () => {
  const { fetch } = await import("undici");
  return {
    safeFetch: (url: string, init: RequestInit & { plugin?: string }) => {
      const { plugin: _plugin, ...rest } = init;
      return fetch(url, rest as Parameters<typeof fetch>[1]);
    },
  };
});

import {
  isConnectionRefusal,
  neverReached,
} from "@/lib/rpc/connection-refusal";
import { safeEthersGetUrl } from "@/lib/rpc/safe-ethers-fetch";
import { isDefinitelyPreBroadcastNetworkError } from "@/lib/web3/submit-signed";

const wrapped = (code: string): Error =>
  Object.assign(new TypeError("fetch failed"), { cause: { code } });
// A JSON-RPC error a node answered with, as ethers keeps it.
const nodeAnswer = (message: string): Error =>
  Object.assign(new Error(`could not coalesce error (${message})`), {
    info: { error: { code: -32_000, message } },
  });

// An HTTP answer from a gateway, as ethers keeps it (SERVER_ERROR).
const gatewayAnswer = (body: string): Error =>
  Object.assign(new Error(`server response 503 (${body})`), {
    code: "SERVER_ERROR",
    info: { responseStatus: 503, responseBody: body },
  });

describe("isConnectionRefusal", () => {
  it.each([
    ["ECONNREFUSED in text", new Error("connect ECONNREFUSED 127.0.0.1:8545")],
    ["connection refused in text", "primary: connection refused"],
  ])("counts %s as never sent", (_label, error) => {
    expect(isConnectionRefusal(error)).toBe(true);
  });

  it.each([
    ["ECONNREFUSED on a cause", wrapped("ECONNREFUSED")],
    ["ENOTFOUND on a cause", wrapped("ENOTFOUND")],
    [
      "an SSRF block",
      Object.assign(new Error("blocked"), { code: "SSRF_BLOCKED" }),
    ],
    ["ENOTFOUND in text", new Error("getaddrinfo ENOTFOUND rpc.example")],
  ])("counts %s as never sent: no redirect is followed", (_label, error) => {
    // Neither the RPC transport nor extra URLs follow redirects, so no earlier hop took the bytes.
    expect(isConnectionRefusal(error)).toBe(true);
  });

  it.each([
    ["a timeout", new Error("timeout after 30000ms")],
    ["a reset", wrapped("ECONNRESET")],
    ["a node answer", new Error("nonce too low")],
    [
      "a node's error naming a refused upstream",
      nodeAnswer("upstream: connect ECONNREFUSED"),
    ],
    [
      "a node's error naming an unresolved upstream",
      nodeAnswer("getaddrinfo ENOTFOUND upstream-2"),
    ],
    [
      "a gateway's 503 body naming a refused upstream",
      gatewayAnswer("delayed connect error: Connection refused"),
    ],
    ["nothing", undefined],
  ])("does not count %s", (_label, error) => {
    expect(isConnectionRefusal(error)).toBe(false);
  });
});

const listen = (server: Server): Promise<string> =>
  new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
    );
  });

describe("a redirect from the real transport", () => {
  it("is no refusal, even when it points at a refused port", async () => {
    // Where the redirect points: nothing listens there.
    const gone = createServer();
    const goneUrl = await listen(gone);
    await new Promise((resolve) => gone.close(resolve));
    const redirect = createServer((_req, res) => {
      res.statusCode = 307;
      res.setHeader("location", goneUrl);
      res.end();
    });
    const request = new FetchRequest(await listen(redirect));
    request.body = new TextEncoder().encode(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_sendRawTransaction",
      })
    );

    try {
      const error = await safeEthersGetUrl(request).then(
        () => undefined,
        (e: unknown) => e
      );
      // The endpoint asked took the bytes: no refusal, and the transport did not follow on.
      expect(isConnectionRefusal(error)).toBe(false);
      expect(neverReached(error)).toBeUndefined();
      expect((error as Error)?.name).toBe("RpcRedirectError");
    } finally {
      redirect.closeAllConnections();
      await new Promise((resolve) => redirect.close(resolve));
    }
  });
});

describe("neverReached", () => {
  it("tells a refusal from an unreached host", () => {
    expect(neverReached(wrapped("ECONNREFUSED"))).toBe("refused");
    expect(neverReached(wrapped("ENOTFOUND"))).toBe("unreachable");
    expect(
      neverReached(
        Object.assign(new Error("blocked"), { code: "SSRF_BLOCKED" })
      )
    ).toBe("unreachable");
    expect(neverReached(wrapped("ECONNRESET"))).toBeUndefined();
  });
});

describe("isDefinitelyPreBroadcastNetworkError", () => {
  it("releases the key for a refusal code on a cause: no redirect is followed", () => {
    expect(isDefinitelyPreBroadcastNetworkError(wrapped("ECONNREFUSED"))).toBe(
      true
    );
  });

  it("does not read a gateway's error body as a refusal", () => {
    expect(
      isDefinitelyPreBroadcastNetworkError(
        gatewayAnswer("upstream connect error: connection refused")
      )
    ).toBe(false);
  });

  it("releases the key for an unresolved host or an SSRF block", () => {
    expect(isDefinitelyPreBroadcastNetworkError(wrapped("ENOTFOUND"))).toBe(
      true
    );
    expect(
      isDefinitelyPreBroadcastNetworkError(
        Object.assign(new Error("blocked"), { code: "SSRF_BLOCKED" })
      )
    ).toBe(true);
  });

  it("needs every endpoint of a failover summary refused", () => {
    expect(
      isDefinitelyPreBroadcastNetworkError(
        new Error("primary: connect ECONNREFUSED fallback: connection refused")
      )
    ).toBe(true);
    expect(
      isDefinitelyPreBroadcastNetworkError(
        new Error("primary: connect ECONNREFUSED fallback: timeout")
      )
    ).toBe(false);
  });

  it("never reads a gateway's HTTP body in a failover summary as a refusal", () => {
    for (const http of [
      'server response 503 (body="upstream connect error, connection refused", code=SERVER_ERROR)',
      "server response 502 Bad Gateway: connection refused",
    ]) {
      expect(
        isDefinitelyPreBroadcastNetworkError(
          new Error(`primary: connect ECONNREFUSED fallback: ${http}`)
        )
      ).toBe(false);
    }
  });

  it("never reads a node's JSON-RPC error text as a refusal", () => {
    expect(
      isDefinitelyPreBroadcastNetworkError(
        nodeAnswer("upstream: connect ECONNREFUSED")
      )
    ).toBe(false);
  });
});
