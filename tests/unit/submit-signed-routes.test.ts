import { ethers, makeError } from "ethers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/sleep", () => ({ sleep: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/logging", () => ({
  ErrorCategory: { NETWORK_RPC: "network_rpc" },
  logSystemError: vi.fn(),
  logSystemWarn: vi.fn(),
  logWarn: vi.fn(),
}));

// Extra URLs go through safeFetch; each test decides what every URL answers.
const { extraAnswer, SsrfBlockedError } = vi.hoisted(() => ({
  extraAnswer: {
    current: (_url: string, _signal: AbortSignal): unknown => undefined,
  },
  SsrfBlockedError: class extends Error {
    readonly code = "SSRF_BLOCKED";
  },
}));
vi.mock("@/lib/safe-fetch", () => ({
  SsrfBlockedError,
  safeFetch: vi.fn((url: string, init: { signal: AbortSignal }) =>
    Promise.resolve(extraAnswer.current(url, init.signal))
  ),
}));

import { logWarn } from "@/lib/logging";
import { RpcProviderManager } from "@/lib/rpc/providers";
import { safeFetch } from "@/lib/safe-fetch";
import { isOnChainPendingError } from "@/lib/web3/onchain-revert";
import {
  NonceConflictError,
  PreBroadcastNetworkError,
  type SendReport,
  sendReportFields,
  submitSignedTransactionWithFailover,
} from "@/lib/web3/submit-signed";

const PUBLIC_URL = "https://public.example";
const RELAY_URL = "https://relay.example";
const EXTRA_A = "https://extra-a.example/v2/secretkey1234567890abcdef";
const EXTRA_B = "https://extra-b.example";

const TX_REQUEST: ethers.TransactionRequest = {
  to: "0x000000000000000000000000000000000000dEaD",
  nonce: 42,
  value: BigInt(0),
  gasLimit: BigInt(21_000),
  maxFeePerGas: BigInt(10_000_000_000),
  maxPriorityFeePerGas: BigInt(1_000_000_000),
  chainId: 1,
  type: 2,
};

let SIGNED_HEX: string;
let HASH: string;

beforeAll(async () => {
  const wallet = new ethers.Wallet(`0x${"1".repeat(64)}`);
  SIGNED_HEX = await wallet.signTransaction(TX_REQUEST);
  HASH = ethers.Transaction.from(SIGNED_HEX).hash as string;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(logWarn).mockClear();
  vi.mocked(safeFetch).mockClear();
});

const signer = {
  populateTransaction: () => Promise.resolve(TX_REQUEST),
  signTransaction: () => Promise.resolve(SIGNED_HEX),
} as unknown as ethers.Signer;

// --- extra URL answers -------------------------------------------------------

const rpcResult = (result: unknown): Response =>
  Response.json({ jsonrpc: "2.0", id: 1, result });
const rpcError = (message: string, code = -32_000): Response =>
  Response.json({ jsonrpc: "2.0", id: 1, error: { code, message } });
const httpStatus = (status: number): Response =>
  new Response("nope", { status });
const refusedConnection = (): Promise<never> =>
  Promise.reject(
    Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ECONNREFUSED" },
    })
  );
// Never answers; rejects once the request's own timeout aborts it.
const hang = (_url: string, signal: AbortSignal): Promise<never> =>
  new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason));
  });

function extras(answers: Record<string, (signal: AbortSignal) => unknown>) {
  extraAnswer.current = (url, signal) => answers[url]?.(signal);
}

// --- managed endpoint ---------------------------------------------------------

const rpcRefusal = (message: string): Error =>
  makeError("could not coalesce error", "UNKNOWN_ERROR", {
    error: { code: -32_000, message },
  });
const accepted = (): Promise<ethers.TransactionResponse> =>
  Promise.resolve({ hash: HASH } as unknown as ethers.TransactionResponse);

type Seen = { replaceableTransaction: ReturnType<typeof vi.fn> } | null;

function stubManaged(opts: {
  broadcast: (url: string) => Promise<unknown>;
  seen?: Seen | Seen[];
  receipt?: unknown;
}): { broadcastCalls: string[]; blockReads: ReturnType<typeof vi.fn> } {
  const broadcastCalls: string[] = [];
  vi.spyOn(
    ethers.JsonRpcProvider.prototype,
    "broadcastTransaction"
  ).mockImplementation(function (this: ethers.JsonRpcProvider) {
    const url = this._getConnection().url;
    broadcastCalls.push(url);
    return opts.broadcast(url) as Promise<ethers.TransactionResponse>;
  });
  vi.spyOn(
    ethers.JsonRpcProvider.prototype,
    "getTransactionReceipt"
  ).mockResolvedValue((opts.receipt ?? null) as ethers.TransactionReceipt);
  // A list answers one lookup each, the last one repeating.
  const seen = Array.isArray(opts.seen) ? [...opts.seen] : [opts.seen ?? null];
  vi.spyOn(
    ethers.JsonRpcProvider.prototype,
    "getTransaction"
  ).mockImplementation(() =>
    Promise.resolve(
      (seen.length > 1
        ? seen.shift()
        : seen[0]) as unknown as ethers.TransactionResponse
    )
  );
  const blockReads = vi.fn().mockResolvedValue(777);
  vi.spyOn(
    ethers.JsonRpcProvider.prototype,
    "getBlockNumber"
  ).mockImplementation(blockReads);
  return { broadcastCalls, blockReads };
}

const seenTx = (): NonNullable<Seen> => ({
  replaceableTransaction: vi.fn().mockReturnValue({ hash: "watched" }),
});

function manager(config: {
  primary?: string;
  fallback?: string;
  relay?: boolean;
  extras?: string[];
}): RpcProviderManager {
  return new RpcProviderManager({
    config: {
      primaryRpcUrl: config.primary ?? PUBLIC_URL,
      fallbackRpcUrl: config.fallback,
      primaryIsPrivateRelay: config.relay ?? false,
      broadcastRpcUrls: config.extras,
      maxRetries: 1,
      chainName: "routes-test",
      chainId: 1,
    },
  });
}

async function send(
  rpc: RpcProviderManager,
  report: SendReport = {}
): Promise<{ result?: unknown; error?: unknown; ms: number }> {
  const started = Date.now();
  try {
    const result = await submitSignedTransactionWithFailover(
      signer,
      TX_REQUEST,
      rpc,
      report
    );
    return { result, ms: Date.now() - started };
  } catch (error) {
    return { error, ms: Date.now() - started };
  }
}

describe("send route reporting", () => {
  it("reports public when a public RPC takes the transaction", async () => {
    stubManaged({ broadcast: accepted });
    const report: SendReport = {};

    await send(manager({}), report);

    expect(sendReportFields(report)).toEqual({
      route: "public",
      included: false,
    });
  });

  it("reports private-relay when the relay takes the transaction", async () => {
    stubManaged({ broadcast: accepted });
    const report: SendReport = {};

    await send(manager({ primary: RELAY_URL, relay: true }), report);

    expect(report.route).toBe("private-relay");
  });

  it("reports public when a non-strict relay send fails over to the public RPC", async () => {
    const { broadcastCalls } = stubManaged({
      broadcast: (url) =>
        url === RELAY_URL ? Promise.reject(new Error("relay 503")) : accepted(),
    });
    const report: SendReport = {};

    await send(
      manager({ primary: RELAY_URL, fallback: PUBLIC_URL, relay: true }),
      report
    );

    expect(broadcastCalls).toEqual([RELAY_URL, PUBLIC_URL]);
    expect(report.route).toBe("public");
  });

  it("keeps private-relay when the public fallback refused the connection", async () => {
    stubManaged({
      broadcast: (url) =>
        Promise.reject(
          url === RELAY_URL
            ? new Error("internal error")
            : new Error("connect ECONNREFUSED")
        ),
      seen: seenTx(),
    });
    const report: SendReport = {};

    const out = await send(
      manager({ primary: RELAY_URL, fallback: PUBLIC_URL, relay: true }),
      report
    );

    expect(out.error).toBeUndefined();
    expect(report.route).toBe("private-relay");
  });

  it("releases the key when the managed RPC's refusal is only a socket code", async () => {
    // The RPC transport follows no redirect: a refused connection sent nothing.
    stubManaged({ broadcast: refusedConnection });
    const report: SendReport = {};

    const out = await send(manager({}), report);

    expect(out.error).toBeInstanceOf(PreBroadcastNetworkError);
    expect(sendReportFields(report)).toEqual({});
  });

  it("releases the key when a strict relay refuses the connection, with no route", async () => {
    const { broadcastCalls } = stubManaged({ broadcast: refusedConnection });
    const report: SendReport = {};

    const out = await send(
      manager({ primary: RELAY_URL, relay: true }),
      report
    );

    expect(broadcastCalls).toEqual([RELAY_URL]);
    expect(out.error).toBeInstanceOf(PreBroadcastNetworkError);
    expect(sendReportFields(report)).toEqual({});
  });

  it("reports no route for a pending send the strict relay never answered", async () => {
    stubManaged({
      broadcast: () => Promise.reject(makeError("request timeout", "TIMEOUT")),
    });
    const report: SendReport = {};

    const out = await send(
      manager({ primary: RELAY_URL, relay: true }),
      report
    );

    // It may still land, so the hash is kept, but the relay never said it took it.
    expect(isOnChainPendingError(out.error)).toBe(true);
    expect(sendReportFields(report)).toEqual({});
  });

  it("reports private-relay once the hash is found after the relay gave no answer", async () => {
    stubManaged({
      broadcast: () => Promise.reject(makeError("request timeout", "TIMEOUT")),
      seen: seenTx(),
    });
    const report: SendReport = {};

    const out = await send(
      manager({ primary: RELAY_URL, relay: true }),
      report
    );

    expect(out.error).toBeUndefined();
    expect(report.route).toBe("private-relay");
  });

  it("keeps the hash when a gateway's error body names a refused upstream", async () => {
    stubManaged({
      broadcast: () =>
        Promise.reject(
          makeError("server response 503", "SERVER_ERROR", {
            info: {
              responseStatus: 503,
              responseBody: "delayed connect error: Connection refused",
            },
          } as never)
        ),
    });

    const out = await send(manager({}));

    expect(isOnChainPendingError(out.error)).toBe(true);
  });

  it("reports no route when nothing left the box", async () => {
    stubManaged({ broadcast: () => Promise.reject(new Error("ECONNREFUSED")) });
    const report: SendReport = {};

    const out = await send(manager({}), report);

    expect(out.error).toBeInstanceOf(PreBroadcastNetworkError);
    expect(sendReportFields(report)).toEqual({});
  });

  it("reports no route on a nonce conflict: our bytes did not land", async () => {
    stubManaged({
      broadcast: () => Promise.reject(rpcRefusal("nonce too low")),
    });
    const report: SendReport = {};

    const out = await send(manager({}), report);

    expect(out.error).toBeInstanceOf(NonceConflictError);
    expect(sendReportFields(report)).toEqual({});
  });

  it("does not read 'unknown transaction type' from the managed RPC as a duplicate", async () => {
    stubManaged({
      broadcast: () =>
        Promise.reject(rpcRefusal("rlp: unknown transaction type")),
    });
    const report: SendReport = {};

    const out = await send(manager({}), report);

    expect(isOnChainPendingError(out.error)).toBe(true);
    expect(sendReportFields(report)).toEqual({});
  });

  it("reports no route when every endpoint answered with a refusal", async () => {
    stubManaged({
      broadcast: () => Promise.reject(rpcRefusal("insufficient funds for gas")),
    });
    extras({ [EXTRA_A]: () => rpcError("insufficient funds for gas") });
    const report: SendReport = {};

    const out = await send(manager({ extras: [EXTRA_A] }), report);

    expect(isOnChainPendingError(out.error)).toBe(true);
    expect(sendReportFields(report)).toEqual({});
  });
});

describe("broadcast to extra RPCs", () => {
  it("sends to the active RPC and every extra URL", async () => {
    stubManaged({ broadcast: accepted });
    extras({
      [EXTRA_A]: () => rpcResult(HASH),
      [EXTRA_B]: () => rpcResult(HASH),
    });

    const out = await send(manager({ extras: [EXTRA_A, EXTRA_B] }));
    await vi.waitFor(() => expect(safeFetch).toHaveBeenCalledTimes(2));

    expect(out.error).toBeUndefined();
    const sentTo = vi.mocked(safeFetch).mock.calls.map((call) => call[0]);
    expect(sentTo.sort()).toEqual([EXTRA_A, EXTRA_B].sort());
    const body = JSON.parse(
      String((vi.mocked(safeFetch).mock.calls[0][1] as RequestInit).body)
    );
    expect(body).toMatchObject({
      method: "eth_sendRawTransaction",
      params: [SIGNED_HEX],
    });
  });

  it("succeeds when only an extra accepts and the managed RPC then sees it", async () => {
    stubManaged({
      broadcast: () => Promise.reject(new Error("primary 500")),
      seen: seenTx(),
    });
    extras({
      [EXTRA_A]: () => httpStatus(503),
      [EXTRA_B]: () => rpcResult(HASH),
    });
    const report: SendReport = {};

    const out = await send(manager({ extras: [EXTRA_A, EXTRA_B] }), report);

    expect(out.result).toMatchObject({
      hash: HASH,
      response: { hash: "watched" },
    });
    expect(report.route).toBe("public");
  });

  it.each([
    ["without 0x", (hash: string) => hash.slice(2)],
    [
      "upper case, padded",
      (hash: string) => ` ${hash.toUpperCase().replace("0X", "0x")} `,
    ],
  ])("accepts our hash written %s", async (_label, spell) => {
    stubManaged({
      broadcast: () => Promise.reject(new Error("primary 500")),
      seen: seenTx(),
    });
    extras({ [EXTRA_A]: () => rpcResult(spell(HASH)) });

    const out = await send(manager({ extras: [EXTRA_A] }));

    expect(out.result).toMatchObject({ hash: HASH });
  });

  it("asks the managed RPC again before giving up on an extra's acceptance", async () => {
    const seen = seenTx();
    stubManaged({
      broadcast: () => Promise.reject(new Error("primary 500")),
      seen: [null, seen],
    });
    extras({ [EXTRA_A]: () => rpcResult(HASH) });

    const out = await send(manager({ extras: [EXTRA_A] }));

    expect(out.result).toMatchObject({ hash: HASH });
    expect(
      ethers.JsonRpcProvider.prototype.getTransaction
    ).toHaveBeenCalledTimes(2);
  });

  it("ends pending with the hash after three missed lookups", async () => {
    stubManaged({ broadcast: () => Promise.reject(new Error("primary 500")) });
    extras({ [EXTRA_A]: () => rpcResult(HASH) });

    const out = await send(manager({ extras: [EXTRA_A] }));

    expect(isOnChainPendingError(out.error)).toBe(true);
    expect(
      ethers.JsonRpcProvider.prototype.getTransaction
    ).toHaveBeenCalledTimes(3);
  });

  it("leaves a failed send without extras as before: no block read, no wrap", async () => {
    const seen = seenTx();
    const { blockReads } = stubManaged({
      broadcast: () => Promise.reject(new Error("reply lost")),
      seen,
    });

    const out = await send(manager({}));

    expect(out.result).toMatchObject({ hash: HASH, response: seen });
    expect(blockReads).not.toHaveBeenCalled();
    expect(seen.replaceableTransaction).not.toHaveBeenCalled();
  });

  it("does not wrap a send that is already mined", async () => {
    const seen = seenTx();
    stubManaged({
      broadcast: () => Promise.reject(new Error("reply lost")),
      seen,
      receipt: { hash: HASH, status: 1 },
    });
    extras({ [EXTRA_A]: () => httpStatus(401) });

    const out = await send(manager({ extras: [EXTRA_A] }));

    expect(out.result).toMatchObject({ response: seen });
    expect(seen.replaceableTransaction).not.toHaveBeenCalled();
  });

  it("gives the response a start block so wait() can spot a replacement", async () => {
    const seen = seenTx();
    stubManaged({
      broadcast: () => Promise.reject(new Error("primary 500")),
      seen,
    });
    extras({ [EXTRA_A]: () => rpcResult(HASH) });

    await send(manager({ extras: [EXTRA_A] }));

    expect(seen.replaceableTransaction).toHaveBeenCalledWith(777);
  });

  it.each([
    "already known",
    "AlreadyKnown",
    "Transaction with the same hash was already imported.",
  ])(
    "counts a duplicate-hash answer (%s) as accepted, with no warning",
    async (message) => {
      stubManaged({
        broadcast: () => Promise.reject(new Error("primary 500")),
        seen: seenTx(),
      });
      extras({ [EXTRA_A]: () => rpcError(message) });

      const out = await send(manager({ extras: [EXTRA_A] }));

      expect(out.error).toBeUndefined();
      expect(logWarn).not.toHaveBeenCalled();
    }
  );

  it.each(["already known", "nonce too low", "insufficient funds for gas"])(
    "keeps the hash, never a nonce conflict, when an extra accepted and the primary said %s",
    async (message) => {
      stubManaged({ broadcast: () => Promise.reject(rpcRefusal(message)) });
      extras({ [EXTRA_A]: () => rpcResult(HASH) });
      const report: SendReport = {};

      const out = await send(manager({ extras: [EXTRA_A] }), report);

      expect(isOnChainPendingError(out.error)).toBe(true);
      expect((out.error as { transactionHash?: string }).transactionHash).toBe(
        HASH
      );
      expect(report.route).toBe("public");
    }
  );

  it("does not report success on a lying extra the managed RPC never saw", async () => {
    stubManaged({
      broadcast: () =>
        Promise.reject(rpcRefusal("max fee per gas less than block base fee")),
    });
    extras({ [EXTRA_A]: () => rpcResult(HASH) });

    const out = await send(manager({ extras: [EXTRA_A] }));

    expect(out.result).toBeUndefined();
    expect(isOnChainPendingError(out.error)).toBe(true);
  });

  it("resolves as soon as one extra accepts, without waiting for a hung one", async () => {
    stubManaged({
      broadcast: () => Promise.reject(new Error("primary 500")),
      seen: seenTx(),
    });
    extras({
      [EXTRA_A]: (signal) => hang(EXTRA_A, signal),
      [EXTRA_B]: () => rpcResult(HASH),
    });

    const out = await send(manager({ extras: [EXTRA_A, EXTRA_B] }));

    expect(out.error).toBeUndefined();
    expect(out.ms).toBeLessThan(1000);
  });

  it("succeeds on a primary error when the hash is then found", async () => {
    stubManaged({
      broadcast: () => Promise.reject(rpcRefusal("already known")),
      seen: seenTx(),
    });
    extras({ [EXTRA_A]: () => rpcError("nonce too low") });

    const out = await send(manager({ extras: [EXTRA_A] }));

    expect(out.result).toMatchObject({ hash: HASH });
  });

  it("ends pending with the hash on 'nonce too low' when an extra may have sent", async () => {
    stubManaged({
      broadcast: () => Promise.reject(rpcRefusal("nonce too low")),
    });
    extras({ [EXTRA_A]: () => httpStatus(502) });

    const out = await send(manager({ extras: [EXTRA_A] }));

    expect(out.error).not.toBeInstanceOf(NonceConflictError);
    expect(isOnChainPendingError(out.error)).toBe(true);
    expect((out.error as { transactionHash?: string }).transactionHash).toBe(
      HASH
    );
  });

  it("ends pending with the hash on 'nonce too low' after a managed attempt timed out", async () => {
    const fallback = "https://fallback.example";
    // The first endpoint may have taken the bytes before timing out.
    const { broadcastCalls } = stubManaged({
      broadcast: (url) =>
        Promise.reject(
          url === fallback
            ? rpcRefusal("nonce too low")
            : makeError("request timeout", "TIMEOUT")
        ),
    });

    const out = await send(manager({ fallback }));

    expect(broadcastCalls).toContain(fallback);
    expect(out.error).not.toBeInstanceOf(NonceConflictError);
    expect(isOnChainPendingError(out.error)).toBe(true);
    expect((out.error as { transactionHash?: string }).transactionHash).toBe(
      HASH
    );
  });

  it("fails as a nonce conflict after a dead primary refused the connection", async () => {
    const fallback = "https://fallback.example";
    // A refused connection sent nothing, so the fallback's nonce answer is the real one.
    const { broadcastCalls } = stubManaged({
      broadcast: (url) =>
        url === fallback
          ? Promise.reject(rpcRefusal("nonce too low"))
          : refusedConnection(),
    });
    const report: SendReport = {};

    const out = await send(manager({ fallback }), report);

    expect(broadcastCalls).toEqual([PUBLIC_URL, fallback]);
    expect(out.error).toBeInstanceOf(NonceConflictError);
    expect(sendReportFields(report)).toEqual({});
  });

  it("asks extras not to follow redirects, so the signed bytes go nowhere else", async () => {
    stubManaged({ broadcast: accepted });
    extras({ [EXTRA_A]: () => rpcResult(HASH) });

    await send(manager({ extras: [EXTRA_A] }));

    await vi.waitFor(() => expect(safeFetch).toHaveBeenCalledTimes(1));
    expect(
      (vi.mocked(safeFetch).mock.calls[0][1] as RequestInit).redirect
    ).toBe("manual");
  });

  it("fails as a nonce conflict when no extra accepted and the hash is not found", async () => {
    stubManaged({
      broadcast: () => Promise.reject(rpcRefusal("nonce too low")),
    });
    extras({
      [EXTRA_A]: () => rpcError("nonce too low"),
      [EXTRA_B]: () => httpStatus(401),
    });

    const out = await send(manager({ extras: [EXTRA_A, EXTRA_B] }));

    expect(out.error).toBeInstanceOf(NonceConflictError);
  });

  it.each([
    ["HTTP 401", () => httpStatus(401)],
    ["a JSON-RPC rejection", () => rpcError("rate limited")],
    ["a refused connection", refusedConnection],
    ["a blocked URL", () => Promise.reject(new SsrfBlockedError("blocked"))],
    [
      "an unresolved host",
      () =>
        Promise.reject(
          Object.assign(new TypeError("fetch failed"), {
            cause: { code: "ENOTFOUND" },
          })
        ),
    ],
    [
      "unknown transaction type",
      () => rpcError("rlp: unknown transaction type"),
    ],
  ])(
    "stays pre-broadcast when the primary was refused and the extra gave %s",
    async (_label, answer) => {
      stubManaged({
        broadcast: () => Promise.reject(new Error("ECONNREFUSED")),
      });
      extras({ [EXTRA_A]: answer });
      const report: SendReport = {};

      const out = await send(manager({ extras: [EXTRA_A] }), report);

      expect(out.error).toBeInstanceOf(PreBroadcastNetworkError);
      expect(report.route).toBeUndefined();
    }
  );

  it.each([
    ["timed out", (signal: AbortSignal) => hang(EXTRA_A, signal)],
    ["answered 502", () => httpStatus(502)],
    // It read the signed bytes before answering, so it may have sent them.
    ["answered a redirect (never followed)", () => httpStatus(307)],
    ["said internal error", () => rpcError("internal error", -32_603)],
    ["returned another hash", () => rpcResult(`0x${"ab".repeat(32)}`)],
    [
      "said its deadline was exceeded",
      () => rpcError("context deadline exceeded"),
    ],
    ["answered 408", () => httpStatus(408)],
    ["sent an oversized body", () => new Response("x".repeat(70_000))],
    [
      "answered 400 with a JSON-RPC 'already known'",
      () =>
        Response.json(
          {
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32_000, message: "already known" },
          },
          { status: 400 }
        ),
    ],
    [
      "answered 400 with a JSON-RPC internal error",
      () =>
        Response.json(
          { jsonrpc: "2.0", id: 1, error: { code: -32_603, message: "oops" } },
          { status: 400 }
        ),
    ],
  ])(
    "is no longer pre-broadcast when an extra %s",
    async (_label, answer) => {
      stubManaged({
        broadcast: () => Promise.reject(new Error("ECONNREFUSED")),
      });
      extras({ [EXTRA_A]: answer });
      const report: SendReport = {};

      const out = await send(manager({ extras: [EXTRA_A] }), report);

      expect(isOnChainPendingError(out.error)).toBe(true);
      expect(report.route).toBe("public");
    },
    10_000
  );

  it.each([false, true])(
    "never sends to the extra URLs on a private relay send (fallback %s)",
    async (withFallback) => {
      stubManaged({ broadcast: accepted });
      const rpc = manager({
        primary: RELAY_URL,
        relay: true,
        fallback: withFallback ? PUBLIC_URL : undefined,
        extras: [EXTRA_A],
      });

      await send(rpc);

      expect(rpc.getBroadcastRpcUrls()).toEqual([]);
      expect(safeFetch).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["a refused connection", refusedConnection, "connection_refused"],
    [
      "an unresolved host",
      () =>
        Promise.reject(
          Object.assign(new TypeError("fetch failed"), {
            cause: { code: "ENOTFOUND" },
          })
        ),
      "unreachable",
    ],
    [
      "a blocked URL",
      () => Promise.reject(new SsrfBlockedError("blocked")),
      "unreachable",
    ],
  ])("logs an extra that met %s as %s", async (_label, answer, kind) => {
    stubManaged({ broadcast: accepted });
    extras({ [EXTRA_A]: answer });

    await send(manager({ extras: [EXTRA_A] }));
    await vi.waitFor(() => expect(logWarn).toHaveBeenCalled());

    expect(vi.mocked(logWarn).mock.calls[0]?.[1]).toMatchObject({
      error_type: kind,
    });
  });

  it("never fails the step or logs the URL when an extra URL fails", async () => {
    stubManaged({ broadcast: accepted });
    extras({
      [EXTRA_A]: () =>
        Promise.reject(new Error(`request to ${EXTRA_A} failed, reason: x`)),
    });

    const out = await send(manager({ extras: [EXTRA_A] }));
    await vi.waitFor(() => expect(logWarn).toHaveBeenCalled());

    expect(out.error).toBeUndefined();
    const logged = JSON.stringify(vi.mocked(logWarn).mock.calls);
    expect(logged).not.toContain("extra-a.example");
    expect(logged).not.toContain("secretkey");
  });
});
