import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  isConnectionRefusal,
  neverReached,
} from "@/lib/rpc/connection-refusal";
import { isDefinitelyPreBroadcastNetworkError } from "@/lib/web3/submit-signed";

const wrapped = (code: string): Error =>
  Object.assign(new TypeError("fetch failed"), { cause: { code } });
// A JSON-RPC error a node answered with, as ethers keeps it.
const nodeAnswer = (message: string): Error =>
  Object.assign(new Error(`could not coalesce error (${message})`), {
    info: { error: { code: -32_000, message } },
  });
const SEND = { followsRedirects: true };
const NO_REDIRECTS = { followsRedirects: false };

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
  ])("counts %s as never sent on every path", (_label, error) => {
    expect(isConnectionRefusal(error, SEND)).toBe(true);
    expect(isConnectionRefusal(error, NO_REDIRECTS)).toBe(true);
  });

  it.each([
    ["ECONNREFUSED on a cause", wrapped("ECONNREFUSED")],
    ["ENOTFOUND on a cause", wrapped("ENOTFOUND")],
    [
      "an SSRF block",
      Object.assign(new Error("blocked"), { code: "SSRF_BLOCKED" }),
    ],
    ["ENOTFOUND in text", new Error("getaddrinfo ENOTFOUND rpc.example")],
  ])(
    "counts %s as never sent only where no redirect is followed",
    (_label, error) => {
      // A redirect hop can fail this way after an earlier hop took the bytes.
      expect(isConnectionRefusal(error, SEND)).toBe(false);
      expect(isConnectionRefusal(error, NO_REDIRECTS)).toBe(true);
    }
  );

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
    expect(isConnectionRefusal(error, SEND)).toBe(false);
    expect(isConnectionRefusal(error, NO_REDIRECTS)).toBe(false);
  });
});

describe("neverReached", () => {
  it("tells a refusal from an unreached host where no redirect is followed", () => {
    expect(neverReached(wrapped("ECONNREFUSED"), NO_REDIRECTS)).toBe("refused");
    expect(neverReached(wrapped("ENOTFOUND"), NO_REDIRECTS)).toBe(
      "unreachable"
    );
    expect(
      neverReached(
        Object.assign(new Error("blocked"), { code: "SSRF_BLOCKED" }),
        NO_REDIRECTS
      )
    ).toBe("unreachable");
    expect(neverReached(wrapped("ECONNRESET"), NO_REDIRECTS)).toBeUndefined();
  });
});

describe("isDefinitelyPreBroadcastNetworkError", () => {
  it("keeps the key for a refusal code on a cause: a redirect hop may have sent", () => {
    expect(isDefinitelyPreBroadcastNetworkError(wrapped("ECONNREFUSED"))).toBe(
      false
    );
  });

  it("does not read a gateway's error body as a refusal", () => {
    expect(
      isDefinitelyPreBroadcastNetworkError(
        gatewayAnswer("upstream connect error: connection refused")
      )
    ).toBe(false);
  });

  it("does not release the key for an unresolved host or an SSRF block", () => {
    expect(isDefinitelyPreBroadcastNetworkError(wrapped("ENOTFOUND"))).toBe(
      false
    );
    expect(
      isDefinitelyPreBroadcastNetworkError(
        Object.assign(new Error("blocked"), { code: "SSRF_BLOCKED" })
      )
    ).toBe(false);
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
