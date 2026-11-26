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
    [
      "a redirect the transport refused to follow",
      Object.assign(
        new Error(
          "RPC endpoint answered with a redirect, which is not followed"
        ),
        { cause: new TypeError("fetch failed") }
      ),
    ],
    ["nothing", undefined],
  ])("does not count %s", (_label, error) => {
    expect(isConnectionRefusal(error)).toBe(false);
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
