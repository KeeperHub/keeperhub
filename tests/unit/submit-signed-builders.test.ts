import { ethers } from "ethers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/sleep", () => ({ sleep: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/logging", () => ({
  ErrorCategory: { NETWORK_RPC: "network_rpc" },
  logSystemError: vi.fn(),
  logSystemWarn: vi.fn(),
  logWarn: vi.fn(),
}));

const { mockBroadcastToBuilders, mockSafeFetch } = vi.hoisted(() => ({
  mockBroadcastToBuilders: vi.fn(),
  mockSafeFetch: vi.fn(),
}));
vi.mock("@/lib/safe-fetch", () => ({ safeFetch: mockSafeFetch }));
vi.mock("@/lib/web3/builder-broadcast", () => ({
  broadcastToBuilders: (...args: unknown[]) => mockBroadcastToBuilders(...args),
}));

import type { RpcProviderManager } from "@/lib/rpc/providers";
import { OnChainPendingError } from "@/lib/web3/onchain-revert";
import {
  isPreBroadcastNetworkError,
  NonceConflictError,
  type SendReport,
  submitSignedTransactionWithFailover,
} from "@/lib/web3/submit-signed";

const TX_REQUEST: ethers.TransactionRequest = {
  to: "0x000000000000000000000000000000000000dEaD",
  nonce: 7,
  value: BigInt(0),
  gasLimit: BigInt(21_000),
  maxFeePerGas: BigInt(10_000_000_000),
  maxPriorityFeePerGas: BigInt(1_000_000_000),
  chainId: 1,
  type: 2,
};

const BUILDERS = { titan: "https://titan.example" };

let SIGNED_HEX: string;
let HASH: string;

beforeAll(async () => {
  const wallet = new ethers.Wallet(`0x${"2".repeat(64)}`);
  SIGNED_HEX = await wallet.signTransaction(TX_REQUEST);
  HASH = ethers.Transaction.from(SIGNED_HEX).hash ?? "";
});

function makeSigner(): ethers.Signer {
  return {
    populateTransaction: vi.fn().mockResolvedValue(TX_REQUEST),
    signTransaction: vi.fn().mockResolvedValue(SIGNED_HEX),
  } as unknown as ethers.Signer;
}

type FakeProvider = {
  sendRaw: ReturnType<typeof vi.fn>;
  getTransactionReceipt?: ReturnType<typeof vi.fn>;
  getTransaction?: ReturnType<typeof vi.fn>;
  getTransactionCount?: ReturnType<typeof vi.fn>;
  getBlockNumber?: ReturnType<typeof vi.fn>;
};

// The calls a send makes: eth_sendRawTransaction, then the response wrap.
function asProvider(fake: FakeProvider): ethers.JsonRpcProvider {
  return {
    ...fake,
    send: (method: string, params: unknown[]) =>
      method === "eth_sendRawTransaction"
        ? (fake.sendRaw as (hex: unknown) => unknown)(params[0])
        : Promise.reject(new Error(`unexpected ${method}`)),
    _wrapTransactionResponse: (tx: { hash: string }) => ({ hash: tx.hash }),
  } as unknown as ethers.JsonRpcProvider;
}

// Runs the broadcast on `active`; `fallback` is what the manager reports as
// its fallback provider.
function makeManager(
  active: ethers.JsonRpcProvider,
  options: { fallback?: unknown; relay?: boolean } = {}
): RpcProviderManager {
  return {
    executeWithFailover: vi.fn(
      async (op: (p: ethers.JsonRpcProvider) => Promise<unknown>) =>
        await op(active)
    ),
    getFallbackProvider: vi.fn().mockReturnValue(options.fallback ?? null),
    getProvider: () => active,
    getBroadcastRpcUrls: () => [],
    isPrivateRelayProvider: () => options.relay === true,
    hasPrivateRelayPrimary: () => options.relay === true,
  } as unknown as RpcProviderManager;
}

describe("submitSignedTransactionWithFailover broadcast info and builders", () => {
  beforeEach(() => {
    mockBroadcastToBuilders.mockReset();
  });

  it("reports the primary RPC and broadcast time, without builders by default", async () => {
    const fake = { sendRaw: vi.fn().mockResolvedValue(HASH) };

    const result = await submitSignedTransactionWithFailover(
      makeSigner(),
      TX_REQUEST,
      makeManager(asProvider(fake))
    );

    expect(result.broadcast?.via).toBe("primary");
    expect(Number.isNaN(Date.parse(result.broadcast?.broadcastAt ?? ""))).toBe(
      false
    );
    expect(result.broadcast?.builders).toBeUndefined();
    expect(mockBroadcastToBuilders).not.toHaveBeenCalled();
  });

  it("reports the fallback RPC when the fallback provider sent it", async () => {
    const provider = asProvider({ sendRaw: vi.fn().mockResolvedValue(HASH) });

    const result = await submitSignedTransactionWithFailover(
      makeSigner(),
      TX_REQUEST,
      makeManager(provider, { fallback: provider })
    );

    expect(result.broadcast?.via).toBe("fallback");
  });

  it("sends the same signed bytes to the builders and reports their results", async () => {
    const fake = { sendRaw: vi.fn().mockResolvedValue(HASH) };
    mockBroadcastToBuilders.mockResolvedValue([
      { name: "titan", accepted: false, error: "busy" },
    ]);
    const report = {};

    const result = await submitSignedTransactionWithFailover(
      makeSigner(),
      TX_REQUEST,
      makeManager(asProvider(fake)),
      report,
      { builderRpcUrls: BUILDERS }
    );

    expect(mockBroadcastToBuilders).toHaveBeenCalledWith(
      SIGNED_HEX,
      HASH,
      BUILDERS
    );
    expect(fake.sendRaw).toHaveBeenCalledWith(SIGNED_HEX);
    expect(result.hash).toBe(HASH);
    expect(result.broadcast?.builders).toEqual([
      { name: "titan", accepted: false, error: "busy" },
    ]);
    expect(report).toEqual({ route: "public" });
  });

  it("never sends to builders beside a private relay send", async () => {
    const fake = { sendRaw: vi.fn().mockResolvedValue(HASH) };
    const report = {};

    const result = await submitSignedTransactionWithFailover(
      makeSigner(),
      TX_REQUEST,
      makeManager(asProvider(fake), { relay: true }),
      report,
      { builderRpcUrls: BUILDERS }
    );

    expect(mockBroadcastToBuilders).not.toHaveBeenCalled();
    expect(result.broadcast?.builders).toBeUndefined();
    expect(report).toEqual({ route: "private-relay" });
  });

  it("keeps the hash when the RPC failed but a builder took the bytes", async () => {
    const fake = {
      sendRaw: vi.fn().mockRejectedValue(new Error("timeout")),
      getTransactionReceipt: vi.fn().mockResolvedValue(null),
      getTransaction: vi.fn().mockResolvedValue(null),
    };
    mockBroadcastToBuilders.mockResolvedValue([
      { name: "titan", accepted: true },
    ]);

    const error = await submitSignedTransactionWithFailover(
      makeSigner(),
      TX_REQUEST,
      makeManager(asProvider(fake)),
      {},
      { builderRpcUrls: BUILDERS }
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OnChainPendingError);
    expect((error as OnChainPendingError).transactionHash).toBe(HASH);
  });

  it("never reports a refused RPC as not sent when a builder took the bytes", async () => {
    const fake = {
      sendRaw: vi.fn().mockRejectedValue(
        Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8545"), {
          code: "ECONNREFUSED",
        })
      ),
      getTransactionReceipt: vi.fn().mockResolvedValue(null),
      getTransaction: vi.fn().mockResolvedValue(null),
    };
    mockBroadcastToBuilders.mockResolvedValue([
      { name: "titan", accepted: true },
    ]);

    const error = await submitSignedTransactionWithFailover(
      makeSigner(),
      TX_REQUEST,
      makeManager(asProvider(fake)),
      {},
      { builderRpcUrls: BUILDERS }
    ).catch((caught: unknown) => caught);

    expect(isPreBroadcastNetworkError(error)).toBe(false);
    expect(error).toBeInstanceOf(OnChainPendingError);
    expect((error as OnChainPendingError).transactionHash).toBe(HASH);
  });

  it("keeps the builders in the result when the RPC refused but later sees the transaction", async () => {
    const fake = {
      sendRaw: vi.fn().mockRejectedValue(refused()),
      getTransaction: vi.fn().mockResolvedValue({ hash: HASH }),
    };
    mockBroadcastToBuilders.mockResolvedValue([
      { name: "titan", accepted: true },
      { name: "beaver", accepted: false, error: "busy" },
    ]);
    const report: SendReport = {};

    const result = await submitSignedTransactionWithFailover(
      makeSigner(),
      TX_REQUEST,
      makeManager(asProvider(fake)),
      report,
      { builderRpcUrls: BUILDERS }
    );

    expect(result.hash).toBe(HASH);
    expect(result.broadcast).toEqual({
      builders: [
        { name: "titan", accepted: true },
        { name: "beaver", accepted: false, error: "busy" },
      ],
    });
    expect(report.route).toBe("public");
  });
});

// Every managed endpoint refused the connection: the request never left.
function refused(): Error {
  return Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8545"), {
    code: "ECONNREFUSED",
  });
}

async function sendWith(
  sendError: Error,
  builders: { name: string; accepted: boolean | null; error?: string }[],
  report: SendReport = {},
  minedNonceCount?: number
): Promise<unknown> {
  const fake = {
    sendRaw: vi.fn().mockRejectedValue(sendError),
    getTransactionReceipt: vi.fn().mockResolvedValue(null),
    getTransaction: vi.fn().mockResolvedValue(null),
    getTransactionCount: vi.fn().mockResolvedValue(minedNonceCount),
  };
  mockBroadcastToBuilders.mockResolvedValue(builders);
  return await submitSignedTransactionWithFailover(
    makeSigner(),
    TX_REQUEST,
    makeManager(asProvider(fake)),
    report,
    { builderRpcUrls: BUILDERS }
  ).catch((caught: unknown) => caught);
}

const pendingHash = (error: unknown): string | undefined =>
  error instanceof OnChainPendingError ? error.transactionHash : undefined;

describe("the outcome when the RPC failed and builders were sent the bytes", () => {
  beforeEach(() => {
    mockBroadcastToBuilders.mockReset();
  });

  it("a builder with no clear answer (timeout after taking the bytes) keeps the hash when the RPC was never reached", async () => {
    const report: SendReport = {};
    const error = await sendWith(
      refused(),
      [{ name: "titan", accepted: null, error: "aborted due to timeout" }],
      report
    );

    expect(isPreBroadcastNetworkError(error)).toBe(false);
    expect(pendingHash(error)).toBe(HASH);
    // Nothing public may hold it: no route.
    expect(report.route).toBeUndefined();
  });

  it("builders that refused leave a refused RPC as never sent", async () => {
    const error = await sendWith(refused(), [
      { name: "titan", accepted: false, error: "rejected" },
    ]);

    expect(isPreBroadcastNetworkError(error)).toBe(true);
  });

  it("a builder that took our hash keeps it, with no public route, when the RPC never sees it", async () => {
    const report: SendReport = {};
    const error = await sendWith(
      refused(),
      [{ name: "titan", accepted: true }],
      report
    );

    expect(pendingHash(error)).toBe(HASH);
    expect(report.route).toBeUndefined();
  });

  it("a nonce already used, with a builder that gave no clear answer, stays a nonce conflict", async () => {
    const error = await sendWith(new Error("nonce too low"), [
      { name: "titan", accepted: null, error: "HTTP 503" },
    ]);

    expect(error).toBeInstanceOf(NonceConflictError);
  });

  it("a nonce already used, with a builder that took our hash, keeps the hash", async () => {
    const error = await sendWith(new Error("nonce too low"), [
      { name: "titan", accepted: true },
    ]);

    expect(error).not.toBeInstanceOf(NonceConflictError);
    expect(pendingHash(error)).toBe(HASH);
  });

  it("a nonce already used, with a builder that took our hash, stays pending while the nonce is not mined", async () => {
    const error = await sendWith(
      new Error("nonce too low"),
      [{ name: "titan", accepted: true }],
      {},
      TX_REQUEST.nonce as number
    );

    expect(pendingHash(error)).toBe(HASH);
  });

  it("a nonce mined by another transaction ends the builder's copy as a nonce conflict", async () => {
    const report: SendReport = {};
    const error = await sendWith(
      new Error("nonce too low"),
      [{ name: "titan", accepted: true }],
      report,
      (TX_REQUEST.nonce as number) + 1
    );

    expect(error).toBeInstanceOf(NonceConflictError);
    expect((error as NonceConflictError).nonce).toBe(TX_REQUEST.nonce);
    expect(report.route).toBeUndefined();
  });

  it("keeps the hash when our transaction shows up after the nonce read", async () => {
    const fake = {
      sendRaw: vi.fn().mockRejectedValue(new Error("nonce too low")),
      getTransaction: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValue({ hash: HASH }),
      getTransactionCount: vi
        .fn()
        .mockResolvedValue((TX_REQUEST.nonce as number) + 1),
    };
    mockBroadcastToBuilders.mockResolvedValue([
      { name: "titan", accepted: true },
    ]);

    const error = await submitSignedTransactionWithFailover(
      makeSigner(),
      TX_REQUEST,
      makeManager(asProvider(fake)),
      {},
      { builderRpcUrls: BUILDERS }
    ).catch((caught: unknown) => caught);

    expect(fake.getTransactionCount).toHaveBeenCalled();
    expect(error).not.toBeInstanceOf(NonceConflictError);
    expect(pendingHash(error)).toBe(HASH);
  });

  it("a replacement answer, with a builder that took our hash, keeps the hash even past the mined nonce", async () => {
    const error = await sendWith(
      new Error("replacement transaction underpriced"),
      [{ name: "titan", accepted: true }],
      {},
      (TX_REQUEST.nonce as number) + 1
    );

    expect(pendingHash(error)).toBe(HASH);
  });

  it.each(["replacement transaction underpriced", "replacement fee too low"])(
    "an RPC that answered %j, with a builder that gave no clear answer, keeps the hash (the nonce is not used yet)",
    async (message) => {
      const error = await sendWith(new Error(message), [
        { name: "titan", accepted: null, error: "aborted due to timeout" },
      ]);

      expect(error).not.toBeInstanceOf(NonceConflictError);
      expect(pendingHash(error)).toBe(HASH);
    }
  );

  it("a replacement answer with builders that refused stays a nonce conflict", async () => {
    const error = await sendWith(
      new Error("replacement transaction underpriced"),
      [{ name: "titan", accepted: false, error: "rejected" }]
    );

    expect(error).toBeInstanceOf(NonceConflictError);
  });

  it.each([
    ["gave no clear answer", null],
    ["took our hash", true],
  ] as const)(
    "with no extras and a builder that %s, a found transaction watches for a replacement from the block read before the send",
    async (_name, accepted) => {
      const replaced = { hash: HASH, replaceable: true };
      const replaceableTransaction = vi.fn().mockReturnValue(replaced);
      const fake = {
        sendRaw: vi.fn().mockRejectedValue(new Error("timeout")),
        getTransactionReceipt: vi.fn().mockResolvedValue(null),
        getTransaction: vi
          .fn()
          .mockResolvedValue({ hash: HASH, replaceableTransaction }),
        // The first read is the one started before the send.
        getBlockNumber: vi.fn().mockResolvedValueOnce(16).mockResolvedValue(17),
      };
      const builders = [{ name: "titan", accepted }];
      mockBroadcastToBuilders.mockResolvedValue(builders);

      const result = await submitSignedTransactionWithFailover(
        makeSigner(),
        TX_REQUEST,
        makeManager(asProvider(fake)),
        {},
        { builderRpcUrls: BUILDERS }
      );

      expect(replaceableTransaction).toHaveBeenCalledWith(16);
      expect(result.response).toBe(replaced);
      expect(result.broadcast).toEqual({ builders });
    }
  );

  it.each([
    "insufficient funds for gas * price + value",
    "max fee per gas less than block base fee",
    "invalid transaction",
  ])(
    "an RPC that answered %j ends as it does without builders when a builder gave no clear answer",
    async (message) => {
      const withBuilder = await sendWith(new Error(message), [
        { name: "titan", accepted: null, error: "HTTP 503" },
      ]);
      const withRefusingBuilder = await sendWith(new Error(message), [
        { name: "titan", accepted: false, error: "rejected" },
      ]);

      expect(pendingHash(withBuilder)).toBe(HASH);
      expect(pendingHash(withRefusingBuilder)).toBe(HASH);
      expect(isPreBroadcastNetworkError(withBuilder)).toBe(false);
    }
  );
});

describe("a bare 4xx from every raw endpoint, with the RPC refused", () => {
  beforeEach(async () => {
    mockBroadcastToBuilders.mockReset();
    mockSafeFetch.mockReset();
    // An HTML page from a CDN or WAF that read the signed bytes.
    mockSafeFetch.mockImplementation(
      async () => new Response("<html>forbidden</html>", { status: 403 })
    );
    const actual = await vi.importActual<
      typeof import("@/lib/web3/builder-broadcast")
    >("@/lib/web3/builder-broadcast");
    mockBroadcastToBuilders.mockImplementation(actual.broadcastToBuilders);
  });

  function refusedProvider() {
    return asProvider({
      sendRaw: vi.fn().mockRejectedValue(refused()),
      getTransactionReceipt: vi.fn().mockResolvedValue(null),
      getTransaction: vi.fn().mockResolvedValue(null),
      getTransactionCount: vi.fn().mockResolvedValue(undefined),
    });
  }

  it("a builder's bare 403 is unclear: pending with the hash, not never sent", async () => {
    const report: SendReport = {};
    const error = await submitSignedTransactionWithFailover(
      makeSigner(),
      TX_REQUEST,
      makeManager(refusedProvider()),
      report,
      { builderRpcUrls: BUILDERS }
    ).catch((caught: unknown) => caught);

    expect(isPreBroadcastNetworkError(error)).toBe(false);
    expect(pendingHash(error)).toBe(HASH);
    expect(report.route).toBeUndefined();
  });

  it("an extra URL's bare 403 is unclear: pending with the hash, not never sent", async () => {
    const manager = {
      ...makeManager(refusedProvider()),
      getBroadcastRpcUrls: () => ["https://extra.example"],
    } as unknown as RpcProviderManager;
    const error = await submitSignedTransactionWithFailover(
      makeSigner(),
      TX_REQUEST,
      manager,
      {}
    ).catch((caught: unknown) => caught);

    expect(isPreBroadcastNetworkError(error)).toBe(false);
    expect(pendingHash(error)).toBe(HASH);
  });
});
