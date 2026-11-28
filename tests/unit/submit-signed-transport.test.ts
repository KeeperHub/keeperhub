import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ethers } from "ethers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/sleep", () => ({ sleep: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/logging", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/logging")>()),
  logSystemError: vi.fn(),
  logSystemWarn: vi.fn(),
  logUserError: vi.fn(),
  logWarn: vi.fn(),
}));
// A load balancer in front of the real transport: it picks a backend per
// request, by JSON-RPC method. The SSRF guard would refuse 127.0.0.1.
const { balancer } = vi.hoisted(() => ({
  balancer: { pick: (_method: string): string => "" },
}));
vi.mock("@/lib/safe-fetch", async () => {
  const { fetch } = await import("undici");
  return {
    safeFetch: (_url: string, init: RequestInit & { plugin?: string }) => {
      const { plugin: _plugin, ...rest } = init;
      const body = new TextDecoder().decode(rest.body as Uint8Array);
      const { method } = JSON.parse(body) as { method: string };
      return fetch(balancer.pick(method), rest as Parameters<typeof fetch>[1]);
    },
  };
});

import { RpcProviderManager } from "@/lib/rpc/providers";
import { isOnChainPendingError } from "@/lib/web3/onchain-revert";
import {
  type BroadcastResult,
  isPreBroadcastNetworkError,
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

let SIGNED_HEX: string;
let HASH: string;

beforeAll(async () => {
  const wallet = new ethers.Wallet(`0x${"3".repeat(64)}`);
  SIGNED_HEX = await wallet.signTransaction(TX_REQUEST);
  HASH = ethers.Transaction.from(SIGNED_HEX).hash as string;
});

const signer = {
  populateTransaction: () => Promise.resolve(TX_REQUEST),
  signTransaction: () => Promise.resolve(SIGNED_HEX),
} as unknown as ethers.Signer;

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    })
  );
});

const urlOf = (server: Server): string =>
  `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

/** A backend that takes the send and has not seen the transaction yet. */
async function healthyBackend(
  sends: string[],
  answerHash: (signedHex: string) => string = ethers.keccak256
): Promise<string> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const { id, method, params } = JSON.parse(body) as {
        id: number;
        method: string;
        params: string[];
      };
      let result: unknown = null;
      if (method === "eth_sendRawTransaction") {
        sends.push(params[0]);
        result = answerHash(params[0]);
      } else if (method === "eth_blockNumber") {
        result = "0x10";
      } else if (method === "eth_chainId") {
        result = "0x1";
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve())
  );
  servers.push(server);
  return urlOf(server);
}

/** A backend that is down: every connection to it is refused. */
async function downBackend(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve())
  );
  const url = urlOf(server);
  await new Promise((resolve) => server.close(resolve));
  return url;
}

function manager(): RpcProviderManager {
  return new RpcProviderManager({
    config: {
      // Both endpoints sit behind the same balancer.
      primaryRpcUrl: "http://lb.example/primary",
      fallbackRpcUrl: "http://lb.example/fallback",
      maxRetries: 2,
      chainName: "transport-test",
      chainId: 1,
    },
  });
}

async function send(
  report: SendReport = {}
): Promise<{ result?: BroadcastResult; error?: unknown }> {
  try {
    const result = await submitSignedTransactionWithFailover(
      signer,
      TX_REQUEST,
      manager(),
      report
    );
    return { result };
  } catch (error) {
    return { error };
  }
}

describe("submitSignedTransactionWithFailover over the real transport", () => {
  it("keeps a delivered send when the block read is refused (one backend down)", async () => {
    const sends: string[] = [];
    const healthy = await healthyBackend(sends);
    const down = await downBackend();
    balancer.pick = (method) => (method === "eth_blockNumber" ? down : healthy);
    const report: SendReport = {};

    const out = await send(report);

    expect(isPreBroadcastNetworkError(out.error)).toBe(false);
    expect(out.error).toBeUndefined();
    expect(out.result?.hash).toBe(HASH);
    // Sent once: the refused block read neither failed the send nor retried it.
    expect(sends).toEqual([SIGNED_HEX]);
    expect(report.route).toBe("public");
  });

  it("still reads a refused send as never sent", async () => {
    const sends: string[] = [];
    const healthy = await healthyBackend(sends);
    const down = await downBackend();
    balancer.pick = (method) =>
      method === "eth_sendRawTransaction" ? down : healthy;
    const report: SendReport = {};

    const out = await send(report);

    expect(isPreBroadcastNetworkError(out.error)).toBe(true);
    expect(isOnChainPendingError(out.error)).toBe(false);
    expect(sends).toEqual([]);
    expect(report.route).toBeUndefined();
  });

  it("returns a response wait() can use, watching for a replacement from the block read with the send", async () => {
    const sends: string[] = [];
    const healthy = await healthyBackend(sends);
    balancer.pick = () => healthy;
    const replaceable = vi.spyOn(
      ethers.TransactionResponse.prototype,
      "replaceableTransaction"
    );

    const out = await send();

    const response = out.result?.response;
    expect(response).toBeInstanceOf(ethers.TransactionResponse);
    expect(response?.hash).toBe(HASH);
    expect(response?.nonce).toBe(7);
    expect(sends).toEqual([SIGNED_HEX]);
    // The backend's block 0x10, read beside the send on the provider that took it.
    expect(replaceable).toHaveBeenCalledWith(16);
    replaceable.mockRestore();
  });

  it("keeps the hash when the send is answered with another transaction hash", async () => {
    const sends: string[] = [];
    const healthy = await healthyBackend(sends, () => `0x${"cd".repeat(32)}`);
    balancer.pick = () => healthy;
    const report: SendReport = {};

    const out = await send(report);

    // Not a clear acceptance, and not a refusal: the bytes may be out.
    expect(isPreBroadcastNetworkError(out.error)).toBe(false);
    expect(isOnChainPendingError(out.error)).toBe(true);
    expect((out.error as { transactionHash?: string }).transactionHash).toBe(
      HASH
    );
    expect(sends.length).toBeGreaterThan(0);
    expect(report.route).toBe("public");
  });
});
