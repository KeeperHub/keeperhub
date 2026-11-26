import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ethers } from "ethers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/sleep", () => ({ sleep: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/logging", () => ({
  ErrorCategory: { NETWORK_RPC: "network_rpc" },
  logSystemError: vi.fn(),
  logSystemWarn: vi.fn(),
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

import { isConnectionRefusal } from "@/lib/rpc/connection-refusal";
import { RpcProviderManager } from "@/lib/rpc/providers";

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

    const error = await manager
      .executeWithFailover(
        // The raw send itself, as broadcastTransaction makes it after its block read.
        (provider) => provider.send("eth_sendRawTransaction", [signed]),
        "write-broadcast"
      )
      .then(
        () => undefined,
        (e: unknown) => e
      );

    expect(String((error as Error)?.message)).toContain(
      "answered with a redirect, which is not followed"
    );
    // The bytes went to the endpoint asked, never to where it pointed.
    expect(redirectHits.map((hit) => hit.body)).toEqual([
      expect.stringContaining(signed.slice(2, 40)),
    ]);
    expect(targetHits).toEqual([]);
    // The endpoint took the request, so this is no refusal.
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
});
