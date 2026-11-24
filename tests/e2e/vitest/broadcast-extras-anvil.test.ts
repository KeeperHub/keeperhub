/**
 * E2E: broadcasting to extra RPC URLs and the fixed Gas Limit, against a local
 * anvil. Real ethers, real RpcProviderManager and safeFetch; small local HTTP
 * proxies stand in for the managed RPC and the extra URLs.
 *
 * Prerequisite: anvil on 127.0.0.1:8546 (chain id 31337). Skipped when
 * SKIP_INFRA_TESTS=true or anvil is not reachable.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { ethers, makeError } from "ethers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/sleep", () => ({ sleep: () => Promise.resolve() }));
vi.mock("@/keeperhub-executor/lib/broadcast-marker", () => ({
  markBroadcast: vi.fn(),
}));
vi.mock("@/lib/logging", () => ({
  ErrorCategory: { NETWORK_RPC: "network_rpc", INFRASTRUCTURE: "infra" },
  logSystemError: vi.fn(),
  logSystemWarn: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logDebug: vi.fn(),
  logUserError: vi.fn(),
}));

import { RpcProviderManager } from "@/lib/rpc/providers";
import { EvmChainAdapter } from "@/lib/web3/chain-adapter/evm";
import { isGasLimitError } from "@/lib/web3/gas-limit-error";
import { isOnChainPendingError } from "@/lib/web3/onchain-revert";
import {
  PreBroadcastNetworkError,
  type SendReport,
  submitSignedTransactionWithFailover,
} from "@/lib/web3/submit-signed";

const ANVIL_URL = process.env.ANVIL_URL ?? "http://127.0.0.1:8546";
const CHAIN_ID = 31_337;
const DEAD = "0x000000000000000000000000000000000000dEaD";

async function anvil(method: string, params: unknown[] = []): Promise<unknown> {
  const response = await fetch(ANVIL_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(2000),
  });
  return ((await response.json()) as { result?: unknown }).result;
}

async function isAnvilReachable(): Promise<boolean> {
  try {
    return (await anvil("eth_chainId")) === `0x${CHAIN_ID.toString(16)}`;
  } catch {
    return false;
  }
}

const shouldSkip =
  process.env.SKIP_INFRA_TESTS === "true" || !(await isAnvilReachable());

// What a proxy does with eth_sendRawTransaction; every other call goes to anvil.
type OnSend =
  | "forward"
  | "hang"
  | "http401"
  | "echoHash"
  | { rpcError: string };

const servers: http.Server[] = [];
const sendCounts = new Map<string, number>();

async function proxy(name: string, onSend: OnSend): Promise<string> {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", async () => {
      const msg = JSON.parse(body) as {
        id: number;
        method: string;
        params: unknown[];
      };
      const reply = (payload: unknown, status = 200): void => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (msg.method === "eth_sendRawTransaction") {
        sendCounts.set(name, (sendCounts.get(name) ?? 0) + 1);
      }
      if (msg.method !== "eth_sendRawTransaction" || onSend === "forward") {
        const upstream = await fetch(ANVIL_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        });
        res.writeHead(upstream.status, { "content-type": "application/json" });
        res.end(await upstream.text());
        return;
      }
      if (onSend === "hang") {
        return;
      }
      if (onSend === "http401") {
        reply({ error: "unauthorized" }, 401);
        return;
      }
      if (onSend === "echoHash") {
        const raw = msg.params[0] as string;
        reply({
          jsonrpc: "2.0",
          id: msg.id,
          result: ethers.Transaction.from(raw).hash,
        });
        return;
      }
      reply({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32_000, message: onSend.rpcError },
      });
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

// The proxies and anvil are on loopback, which safeFetch blocks outside shadow mode.
beforeAll(() => {
  vi.stubEnv("SAFE_FETCH_SHADOW", "true");
});

afterAll(() => {
  vi.unstubAllEnvs();
  for (const server of servers) {
    server.closeAllConnections();
    server.close();
  }
});

function manager(opts: {
  primary: string;
  extras?: string[];
  relay?: boolean;
}): RpcProviderManager {
  return new RpcProviderManager({
    config: {
      primaryRpcUrl: opts.primary,
      chainId: CHAIN_ID,
      chainName: "anvil",
      maxRetries: 1,
      timeoutMs: 3000,
      primaryIsPrivateRelay: opts.relay ?? false,
      broadcastRpcUrls: opts.extras ?? [],
    },
  });
}

async function fundedWallet(provider: ethers.Provider): Promise<ethers.Wallet> {
  const wallet = new ethers.Wallet(
    ethers.Wallet.createRandom().privateKey,
    provider
  );
  await anvil("anvil_setBalance", [wallet.address, "0xDE0B6B3A7640000"]);
  return wallet;
}

async function transferRequest(
  wallet: ethers.Wallet,
  fee = BigInt(50_000_000_000)
): Promise<ethers.TransactionRequest> {
  return {
    to: DEAD,
    value: BigInt(1),
    from: wallet.address,
    nonce: Number(
      await anvil("eth_getTransactionCount", [wallet.address, "pending"])
    ),
    gasLimit: BigInt(21_000),
    maxFeePerGas: fee,
    maxPriorityFeePerGas: BigInt(1_000_000_000),
    chainId: CHAIN_ID,
    type: 2,
  };
}

async function send(rpc: RpcProviderManager): Promise<{
  result?: { hash: string; response: ethers.TransactionResponse };
  error?: unknown;
  report: SendReport;
  ms: number;
}> {
  const wallet = await fundedWallet(rpc.getProvider());
  const report: SendReport = {};
  const started = Date.now();
  try {
    const result = await submitSignedTransactionWithFailover(
      wallet,
      await transferRequest(wallet),
      rpc,
      report
    );
    return { result, report, ms: Date.now() - started };
  } catch (error) {
    return { error, report, ms: Date.now() - started };
  }
}

describe.skipIf(shouldSkip)("broadcast to extra RPCs (anvil E2E)", () => {
  it("lands the transaction when only an extra URL takes it", {
    timeout: 30_000,
  }, async () => {
    const out = await send(
      manager({
        primary: await proxy("p1", { rpcError: "internal error" }),
        extras: [await proxy("x1", "forward")],
      })
    );

    expect(out.error).toBeUndefined();
    expect(out.report.route).toBe("public");
    const receipt = await out.result?.response.wait();
    expect(receipt?.status).toBe(1);
  });

  it("lets wait() report a replacement of an extra-only send", {
    timeout: 60_000,
  }, async () => {
    const interval = Number(await anvil("anvil_getIntervalMining"));
    const automine = Boolean(await anvil("anvil_getAutomine"));
    await anvil("evm_setAutomine", [false]);
    await anvil("evm_setIntervalMining", [0]);
    try {
      const rpc = manager({
        primary: await proxy("p2", { rpcError: "internal error" }),
        extras: [await proxy("x2", "forward")],
      });
      const wallet = await fundedWallet(rpc.getProvider());
      const original = await transferRequest(wallet);
      const result = await submitSignedTransactionWithFailover(
        wallet,
        original,
        rpc
      );

      // Same nonce, higher fee, different value: a different transaction takes it.
      const replacement = await wallet.signTransaction({
        ...original,
        value: BigInt(2),
        maxFeePerGas: BigInt(100_000_000_000),
        maxPriorityFeePerGas: BigInt(5_000_000_000),
      });
      await anvil("eth_sendRawTransaction", [replacement]);
      await anvil("evm_mine");

      await expect(result.response.wait()).rejects.toMatchObject({
        code: "TRANSACTION_REPLACED",
        cancelled: true,
      });
    } finally {
      await anvil("evm_setAutomine", [automine]);
      await anvil("evm_setIntervalMining", [interval]);
    }
  });

  it("does not wait for a hung extra once another one accepted", {
    timeout: 30_000,
  }, async () => {
    const out = await send(
      manager({
        primary: await proxy("p3", { rpcError: "internal error" }),
        extras: [await proxy("x3a", "hang"), await proxy("x3b", "forward")],
      })
    );

    expect(out.error).toBeUndefined();
    expect(out.ms).toBeLessThan(2000);
  });

  it.each([
    ["HTTP 401", "http401" as const],
    ["a JSON-RPC rejection", { rpcError: "rate limited" }],
  ])(
    "stays pre-broadcast when the primary refused and the extra answered %s",
    { timeout: 30_000 },
    async (_label, onSend) => {
      const out = await send(
        manager({
          primary: await proxy(`p4-${_label}`, {
            rpcError: "connect ECONNREFUSED 10.0.0.1:443",
          }),
          extras: [await proxy(`x4-${_label}`, onSend)],
        })
      );

      expect(out.error).toBeInstanceOf(PreBroadcastNetworkError);
      expect(out.report.route).toBeUndefined();
    }
  );

  it.each(["already known", "insufficient funds for gas * price + value"])(
    "keeps the hash, not success, when an extra echoed the hash and the primary said %s",
    { timeout: 30_000 },
    async (message) => {
      const out = await send(
        manager({
          primary: await proxy(`p5-${message}`, { rpcError: message }),
          extras: [await proxy(`x5-${message}`, "echoHash")],
        })
      );

      expect(out.result).toBeUndefined();
      expect(isOnChainPendingError(out.error)).toBe(true);
      expect(
        (out.error as { transactionHash?: string }).transactionHash
      ).toMatch(/^0x[0-9a-f]{64}$/);
    }
  );

  it.each([
    "already known",
    "AlreadyKnown",
    "transaction already imported",
    "Known transaction",
  ])(
    "keeps the hash as pending when the managed RPC says %s and cannot find it",
    {
      timeout: 30_000,
    },
    async (message) => {
      const out = await send(
        manager({
          primary: await proxy(`dup-${message}`, { rpcError: message }),
        })
      );

      expect(isOnChainPendingError(out.error)).toBe(true);
      expect(
        (out.error as { transactionHash?: string }).transactionHash
      ).toMatch(/^0x[0-9a-f]{64}$/);
      expect(out.report.route).toBe("public");
    }
  );

  it("never sends to the extra URLs through the private relay", {
    timeout: 30_000,
  }, async () => {
    const out = await send(
      manager({
        primary: await proxy("relay6", "forward"),
        extras: [await proxy("x6", "forward")],
        relay: true,
      })
    );

    expect(out.report.route).toBe("private-relay");
    expect(sendCounts.get("x6") ?? 0).toBe(0);
  });
});

describe.skipIf(shouldSkip)("fixed Gas Limit (anvil E2E)", () => {
  // PUSH1 1 PUSH1 0 SSTORE STOP: one zero-to-one write.
  const STORER_CODE = "0x600160005500";
  // Five zero-to-one writes, about 110k gas.
  const HEAVY_CODE = "0x6001600055600160015560016002556001600355600160045500";
  // Calls the heavy contract with all its gas; reverts 0xdeadbeef if that fails.
  const wrapperCode = (inner: string): string =>
    `0x6000600060006000600073${inner.slice(2).toLowerCase()}5af1603457` +
    "63deadbeef60e01b60005260046000fd5b00";

  async function contractWith(code: string): Promise<string> {
    const address = ethers.Wallet.createRandom().address;
    await anvil("anvil_setCode", [address, code]);
    return address;
  }

  async function poke(opts: {
    gasLimit?: bigint;
    nextBlock?: boolean;
    target?: string;
    failFirstCall?: boolean;
  }) {
    const target = opts.target ?? (await contractWith(STORER_CODE));
    const rpc = new RpcProviderManager({
      config: { primaryRpcUrl: ANVIL_URL, chainId: CHAIN_ID, maxRetries: 1 },
    });
    const provider = rpc.getProvider();
    let estimates = 0;
    let failNextCall = opts.failFirstCall ?? false;
    const send = provider.send.bind(provider);
    provider.send = (method, params) => {
      estimates += method === "eth_estimateGas" ? 1 : 0;
      if (method === "eth_call" && failNextCall) {
        failNextCall = false;
        // A one-off node error: ethers reports it on eth_call as CALL_EXCEPTION.
        return Promise.reject(
          makeError("header not found", "CALL_EXCEPTION", {
            action: "call",
            data: null,
            reason: null,
            transaction: { to: target, data: "0x" },
            invocation: null,
            revert: null,
          })
        );
      }
      return send(method, params);
    };
    const wallet = await fundedWallet(provider);
    const gasStrategy = {
      getGasConfig: (
        _p: unknown,
        estimate: bigint | undefined,
        _c: number,
        _m?: number,
        fixed?: bigint
      ) =>
        Promise.resolve({
          gasLimit: fixed ?? (estimate as bigint),
          maxFeePerGas: BigInt(50_000_000_000),
          maxPriorityFeePerGas: BigInt(1_000_000_000),
        }),
    };
    const nonceManager = {
      getNextNonce: (session: { currentNonce: number }) => session.currentNonce,
      recordTransaction: vi.fn().mockResolvedValue(undefined),
      confirmTransaction: vi.fn().mockResolvedValue(undefined),
    };
    const adapter = new EvmChainAdapter(
      CHAIN_ID,
      gasStrategy as never,
      nonceManager as never
    );
    const nonce = await wallet.getNonce("pending");
    let error: unknown;
    try {
      await adapter.executeContractCall(
        wallet,
        {
          contractAddress: target,
          abi: ["function poke()"],
          functionKey: "poke",
          args: [],
        },
        { currentNonce: nonce } as never,
        {
          gasOverrides: opts.gasLimit
            ? { gasLimitOverride: opts.gasLimit }
            : {},
          rpcManager: rpc,
          // A set offset: anvil blocks can share a timestamp when tests mine fast.
          ...(opts.nextBlock ? { simulation: { timestampOffsetSec: 1 } } : {}),
        }
      );
    } catch (caught) {
      error = caught;
    }
    return {
      error,
      estimates,
      sent: (await wallet.getNonce("pending")) - nonce,
    };
  }

  const TOO_LOW_TAIL = "Raise the Gas Limit or leave it empty.";

  it("names a Gas Limit too low before sending (Simulate at: Latest)", {
    timeout: 30_000,
  }, async () => {
    const out = await poke({ gasLimit: BigInt(30_000) });

    expect(isGasLimitError(out.error)).toBe(true);
    expect((out.error as Error).message).toBe(
      `Gas Limit 30000 is too low for this call: the call fails under that limit and passes without one. ${TOO_LOW_TAIL}`
    );
    expect(out.sent).toBe(0);
    expect(out.estimates).toBe(0);
  });

  it("names the Gas Limit when a sub-call runs out of gas and the caller reverts with data", {
    timeout: 30_000,
  }, async () => {
    const wrapper = await contractWith(
      wrapperCode(await contractWith(HEAVY_CODE))
    );

    const out = await poke({ gasLimit: BigInt(60_000), target: wrapper });

    expect((out.error as Error).message).toBe(
      `Gas Limit 60000 is too low for this call: the call fails under that limit and passes without one. ${TOO_LOW_TAIL}`
    );
    expect(out.sent).toBe(0);
  });

  it("does not blame the Gas Limit for a one-off node error", {
    timeout: 30_000,
  }, async () => {
    const out = await poke({ gasLimit: BigInt(100_000), failFirstCall: true });

    expect(out.error).toBeUndefined();
    expect(out.sent).toBe(1);
  });

  it("tests the Gas Limit directly at the next block and fails before sending", {
    timeout: 30_000,
  }, async () => {
    const out = await poke({ gasLimit: BigInt(30_000), nextBlock: true });

    expect(isGasLimitError(out.error)).toBe(true);
    expect((out.error as Error).message).toMatch(
      /^Gas Limit 30000 is too low for this call, which needs about \d+ gas\. Raise the Gas Limit or leave it empty\.$/
    );
    expect(out.sent).toBe(0);
  });

  it("names the Gas Limit at the next block when a sub-call runs out of gas", {
    timeout: 30_000,
  }, async () => {
    const wrapper = await contractWith(
      wrapperCode(await contractWith(HEAVY_CODE))
    );

    const out = await poke({
      gasLimit: BigInt(60_000),
      nextBlock: true,
      target: wrapper,
    });

    expect(isGasLimitError(out.error)).toBe(true);
    expect(out.sent).toBe(0);
  });

  it("sends at the next block with an adequate fixed limit", {
    timeout: 30_000,
  }, async () => {
    const out = await poke({ gasLimit: BigInt(100_000), nextBlock: true });

    expect(out.error).toBeUndefined();
    expect(out.sent).toBe(1);
  });

  it("sends with an adequate fixed limit and makes no estimate", {
    timeout: 30_000,
  }, async () => {
    const out = await poke({ gasLimit: BigInt(100_000) });

    expect(out.error).toBeUndefined();
    expect(out.sent).toBe(1);
    expect(out.estimates).toBe(0);
  });

  it("estimates without a fixed limit", { timeout: 30_000 }, async () => {
    const out = await poke({});

    expect(out.error).toBeUndefined();
    expect(out.estimates).toBe(1);
  });
});
