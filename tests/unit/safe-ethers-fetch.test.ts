import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ethers } from "ethers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/sleep", () => ({ sleep: vi.fn().mockResolvedValue(undefined) }));
const { logSystemError, logUserError } = vi.hoisted(() => ({
  logSystemError: vi.fn(),
  logUserError: vi.fn(),
}));
vi.mock("@/lib/logging", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/logging")>()),
  logSystemError,
  logSystemWarn: vi.fn(),
  logUserError,
  logWarn: vi.fn(),
}));
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

import { classifyExecutionError } from "@/lib/errors/classify";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import { isConnectionRefusal } from "@/lib/rpc/connection-refusal";
import {
  declaredErrorClass,
  RpcProviderManager,
  RpcUserEndpointError,
  rpcRelayErrorClass,
} from "@/lib/rpc/providers";
import {
  broadcastTransactionHash,
  isOnChainPendingError,
} from "@/lib/web3/onchain-revert";
import {
  isPreBroadcastNetworkError,
  submitSignedTransactionWithFailover,
} from "@/lib/web3/submit-signed";

type Hit = { method?: string; body: string };

function listen(
  handler: (body: string, res: import("node:http").ServerResponse) => void,
  hits: Hit[]
): Promise<Server> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      hits.push({ method: req.method, body });
      handler(body, res);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

const urlOf = (server: Server): string =>
  `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

describe("the RPC transport does not follow redirects", () => {
  const servers: Server[] = [];
  let redirectHits: Hit[];
  let targetHits: Hit[];
  let redirect: Server;

  beforeEach(async () => {
    redirectHits = [];
    targetHits = [];
    const target = await listen((body, res) => {
      const { id } = JSON.parse(body) as { id: number };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result: "0x1" }));
    }, targetHits);
    const targetUrl = urlOf(target);
    redirect = await listen((_body, res) => {
      res.statusCode = 307;
      res.setHeader("location", targetUrl);
      res.end();
    }, redirectHits);
    servers.push(target, redirect);
  });

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map((server) => {
        server.closeAllConnections();
        return new Promise((resolve) => server.close(resolve));
      })
    );
  });

  it("fails a send on a 307 without re-posting the signed bytes", async () => {
    const wallet = new ethers.Wallet(`0x${"1".repeat(64)}`);
    const signed = await wallet.signTransaction({
      to: "0x000000000000000000000000000000000000dEaD",
      nonce: 0,
      gasLimit: BigInt(21_000),
      maxFeePerGas: BigInt(1),
      maxPriorityFeePerGas: BigInt(1),
      chainId: 1,
      type: 2,
    });
    const manager = new RpcProviderManager({
      config: {
        primaryRpcUrl: urlOf(redirect),
        maxRetries: 1,
        chainName: "redirect-test",
        chainId: 1,
      },
    });

    // The send path a write takes: the raw send alone, then the hash lookups.
    const error = await submitSignedTransactionWithFailover(
      {
        populateTransaction: (tx: ethers.TransactionRequest) =>
          Promise.resolve(tx),
        signTransaction: () => Promise.resolve(signed),
      } as unknown as ethers.Signer,
      {},
      manager
    ).then(
      () => undefined,
      (e: unknown) => e
    );

    // The bytes went to the endpoint asked, never to where it pointed.
    const sends = redirectHits.filter((hit) =>
      hit.body.includes("eth_sendRawTransaction")
    );
    expect(sends.map((hit) => hit.body)).toEqual([
      expect.stringContaining(signed.slice(2, 40)),
    ]);
    expect(targetHits).toEqual([]);
    // The endpoint took the request: the hash is kept, never "never sent".
    expect(isPreBroadcastNetworkError(error)).toBe(false);
    expect(isOnChainPendingError(error)).toBe(true);
    expect(broadcastTransactionHash(error)).toBe(
      ethers.Transaction.from(signed).hash
    );
  });

  it("does not count the transport's redirect error as a refusal", async () => {
    const manager = new RpcProviderManager({
      config: {
        primaryRpcUrl: urlOf(redirect),
        maxRetries: 1,
        chainName: "redirect-test",
        chainId: 1,
      },
    });
    const error = await manager
      .executeWithFailover(
        (provider) => provider.send("eth_sendRawTransaction", ["0x00"]),
        "write-broadcast"
      )
      .then(
        () => undefined,
        (e: unknown) => e
      );
    expect(String((error as Error)?.message)).toContain(
      "answered with a redirect, which is not followed"
    );
    expect(isConnectionRefusal(error)).toBe(false);
  });

  it("fails a read on a 307 the same way", async () => {
    const manager = new RpcProviderManager({
      config: {
        primaryRpcUrl: urlOf(redirect),
        maxRetries: 1,
        chainName: "redirect-test",
        chainId: 1,
      },
    });

    await expect(
      manager.executeWithFailover((provider) => provider.getBlockNumber())
    ).rejects.toThrow("redirect");
    expect(targetHits).toEqual([]);
  });

  it("does not retry a redirect on the same endpoint", async () => {
    const manager = new RpcProviderManager({
      config: {
        primaryRpcUrl: urlOf(redirect),
        maxRetries: 3,
        chainName: "redirect-test",
        chainId: 1,
      },
    });
    await expect(
      manager.executeWithFailover((provider) => provider.getBlockNumber())
    ).rejects.toThrow(
      "RPC endpoint answered with a redirect, which is not followed"
    );
    expect(redirectHits).toHaveLength(1);
  });

  it("reads the user's own redirecting RPC preference as their configuration", async () => {
    logSystemError.mockClear();
    logUserError.mockClear();
    const manager = new RpcProviderManager({
      config: {
        primaryRpcUrl: urlOf(redirect),
        fallbackRpcUrl: `${urlOf(redirect)}/other`,
        maxRetries: 1,
        chainName: "Ethereum",
        chainId: 1,
        userRpc: true,
      },
    });
    const error = await manager
      .executeWithFailover((provider) => provider.getBlockNumber())
      .then(
        () => undefined,
        (e: unknown) => e
      );
    expect(error).toBeInstanceOf(RpcUserEndpointError);
    expect(rpcRelayErrorClass(error)).toBe(ExecutionErrorType.USER);
    expect((error as Error).message).toBe(
      "Your RPC preference for Ethereum answered with a redirect, which is not followed; set it to the final https:// address"
    );
    // A step that wraps it passes this class along, so it stays a user error, not N-0001.
    expect(declaredErrorClass(error)).toEqual({
      errorClass: ExecutionErrorType.USER,
    });
    expect(isConnectionRefusal(error)).toBe(false);
    expect(logSystemError).not.toHaveBeenCalled();
    expect(logUserError).toHaveBeenCalledTimes(1);
  });

  it("keeps a platform URL's redirect a platform fault", async () => {
    logSystemError.mockClear();
    const manager = new RpcProviderManager({
      config: {
        primaryRpcUrl: urlOf(redirect),
        fallbackRpcUrl: `${urlOf(redirect)}/other`,
        maxRetries: 1,
        chainName: "Ethereum",
        chainId: 1,
      },
    });
    const error = await manager
      .executeWithFailover((provider) => provider.getBlockNumber())
      .then(
        () => undefined,
        (e: unknown) => e
      );
    expect(error).not.toBeInstanceOf(RpcUserEndpointError);
    expect(classifyExecutionError((error as Error).message)).toMatchObject({
      errorType: ExecutionErrorType.SYSTEM,
      code: "N-0001",
    });
    expect(logSystemError).toHaveBeenCalledWith(
      "network_rpc",
      expect.stringContaining("Both primary and fallback RPC failed"),
      expect.any(String),
      expect.objectContaining({ event: "RPC_BOTH_ENDPOINTS_FAILED" })
    );
  });

  it("does not blame the user when the relay in front of their URL redirected", async () => {
    const manager = new RpcProviderManager({
      config: {
        primaryRpcUrl: urlOf(redirect),
        fallbackRpcUrl: `${urlOf(redirect)}/other`,
        maxRetries: 1,
        chainName: "Ethereum",
        chainId: 1,
        userRpc: true,
        primaryIsPrivateRelay: true,
      },
    });
    const error = await manager
      .executeWithFailover((provider) => provider.getBlockNumber())
      .then(
        () => undefined,
        (e: unknown) => e
      );
    expect(error).not.toBeInstanceOf(RpcUserEndpointError);
  });
});
