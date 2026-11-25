/**
 * E2E: the Latest-mode pre-send check through a private relay that refuses
 * eth_call (as Flashbots Protect does: HTTP 403, -32601 "rpc method is not
 * whitelisted") and answers eth_estimateGas. A local proxy in front of anvil
 * plays the relay; real ethers, RpcProviderManager and EvmChainAdapter.
 *
 * Prerequisite: anvil on 127.0.0.1:8546 (chain id 31337). Skipped when
 * SKIP_INFRA_TESTS=true or anvil is not reachable.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { ethers, isError } from "ethers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
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

const ANVIL_URL = process.env.ANVIL_URL ?? "http://127.0.0.1:8546";
const CHAIN_ID = 31_337;
const DEAD = "0x000000000000000000000000000000000000dEaD";
// PUSH1 1 PUSH1 0 SSTORE STOP: one zero-to-one write.
const STORER_CODE = "0x600160005500";
// Reverts with 0xdeadbeef.
const REVERTER_CODE = "0x63deadbeef60e01b60005260046000fd";

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

type Seen = { method: string; params: unknown[] }[];

const servers: http.Server[] = [];

// Seen allowed on rpc.flashbots.net (2026-11-25); anything else gets 403 / -32601.
const RELAY_ALLOWED = new Set([
  "eth_chainId",
  "eth_blockNumber",
  "eth_getBlockByNumber",
  "eth_feeHistory",
  "eth_maxPriorityFeePerGas",
  "eth_gasPrice",
  "eth_getTransactionCount",
  "eth_getBalance",
  "eth_getTransactionReceipt",
  "eth_getTransactionByHash",
  "eth_estimateGas",
  "eth_sendRawTransaction",
]);

/** A relay that allows only what Flashbots Protect allows. */
async function strictRelay(seen: Seen): Promise<string> {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", async () => {
      const parsed = JSON.parse(body) as
        | { id: number; method: string; params: unknown[] }
        | { id: number; method: string; params: unknown[] }[];
      const calls = Array.isArray(parsed) ? parsed : [parsed];
      for (const call of calls) {
        seen.push({ method: call.method, params: call.params });
      }
      if (calls.some((call) => !RELAY_ALLOWED.has(call.method))) {
        const refusal = (id: number) => ({
          jsonrpc: "2.0",
          id,
          error: { code: -32_601, message: "rpc method is not whitelisted" },
        });
        res.writeHead(403, { "content-type": "application/json" });
        res.end(
          JSON.stringify(
            Array.isArray(parsed)
              ? calls.map((call) => refusal(call.id))
              : refusal(calls[0].id)
          )
        );
        return;
      }
      const upstream = await fetch(ANVIL_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      res.writeHead(upstream.status, { "content-type": "application/json" });
      res.end(await upstream.text());
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

// The proxy and anvil are on loopback, which safeFetch blocks outside shadow mode.
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

async function contractWith(code: string): Promise<string> {
  const address = ethers.Wallet.createRandom().address;
  await anvil("anvil_setCode", [address, code]);
  return address;
}

function harness(): EvmChainAdapter {
  const gasStrategy = {
    getGasConfig: (
      _p: unknown,
      estimate: bigint | undefined,
      _c: number,
      _m?: number,
      fixed?: bigint
    ) =>
      Promise.resolve({
        gasLimit: fixed ?? (estimate as bigint) + BigInt(10_000),
        maxFeePerGas: BigInt(50_000_000_000),
        maxPriorityFeePerGas: BigInt(1_000_000_000),
      }),
  };
  const nonceManager = {
    getNextNonce: (session: { currentNonce: number }) => session.currentNonce,
    recordTransaction: vi.fn().mockResolvedValue(undefined),
    confirmTransaction: vi.fn().mockResolvedValue(undefined),
  };
  return new EvmChainAdapter(
    CHAIN_ID,
    gasStrategy as never,
    nonceManager as never
  );
}

async function setup(relay = true) {
  const seen: Seen = [];
  const url = await strictRelay(seen);
  const rpc = new RpcProviderManager({
    config: {
      primaryRpcUrl: url,
      chainId: CHAIN_ID,
      chainName: "anvil",
      maxRetries: 1,
      timeoutMs: 5000,
      primaryIsPrivateRelay: relay,
    },
  });
  const wallet = new ethers.Wallet(
    ethers.Wallet.createRandom().privateKey,
    rpc.getProvider()
  );
  await anvil("anvil_setBalance", [wallet.address, "0xDE0B6B3A7640000"]);
  return { seen, rpc, wallet, adapter: harness() };
}

async function poke(opts: {
  target: string;
  gasLimit?: bigint;
  relay?: boolean;
}) {
  const { seen, rpc, wallet, adapter } = await setup(opts.relay ?? true);
  const nonce = await wallet.getNonce("pending");
  let error: unknown;
  try {
    await adapter.executeContractCall(
      wallet,
      {
        contractAddress: opts.target,
        abi: ["function poke()"],
        functionKey: "poke",
        args: [],
      },
      { currentNonce: nonce } as never,
      {
        gasOverrides: opts.gasLimit ? { gasLimitOverride: opts.gasLimit } : {},
        rpcManager: rpc,
      }
    );
  } catch (caught) {
    error = caught;
  }
  return {
    error,
    seen,
    calls: seen.filter((entry) => entry.method === "eth_call").length,
    estimates: seen.filter((entry) => entry.method === "eth_estimateGas"),
    sent: (await wallet.getNonce("pending")) - nonce,
  };
}

describe.skipIf(shouldSkip)(
  "pre-send check through a strict private relay (anvil E2E)",
  () => {
    it("a normal-send adapter checks with eth_call, which the relay refuses", {
      timeout: 30_000,
    }, async () => {
      // Without the relay flag the adapter checks with eth_call.
      const out = await poke({
        target: await contractWith(STORER_CODE),
        relay: false,
      });

      expect(out.error).toBeDefined();
      expect(out.calls).toBeGreaterThan(0);
      expect(out.sent).toBe(0);
    });

    it("checks with eth_estimateGas and sends", {
      timeout: 30_000,
    }, async () => {
      const out = await poke({ target: await contractWith(STORER_CODE) });

      expect(out.error).toBeUndefined();
      expect(out.calls).toBe(0);
      expect(out.estimates).toHaveLength(1);
      expect(out.sent).toBe(1);
    });

    it("stops a reverting call before sending", {
      timeout: 30_000,
    }, async () => {
      const out = await poke({ target: await contractWith(REVERTER_CODE) });

      expect(isError(out.error, "CALL_EXCEPTION")).toBe(true);
      expect((out.error as { data?: string }).data).toBe("0xdeadbeef");
      expect(out.calls).toBe(0);
      expect(out.sent).toBe(0);
    });

    it("stops a reverting call under a fixed Gas Limit", {
      timeout: 30_000,
    }, async () => {
      const out = await poke({
        target: await contractWith(REVERTER_CODE),
        gasLimit: BigInt(100_000),
      });

      expect(isError(out.error, "CALL_EXCEPTION")).toBe(true);
      expect(isGasLimitError(out.error)).toBe(false);
      expect(out.calls).toBe(0);
      expect(out.sent).toBe(0);
    });

    it("passes the fixed Gas Limit as gas and sends", {
      timeout: 30_000,
    }, async () => {
      const out = await poke({
        target: await contractWith(STORER_CODE),
        gasLimit: BigInt(100_000),
      });

      expect(out.error).toBeUndefined();
      expect(out.calls).toBe(0);
      expect(out.estimates).toHaveLength(1);
      expect((out.estimates[0].params[0] as { gas?: string }).gas).toBe(
        "0x186a0"
      );
      // Pinned to the block the limit was checked against.
      expect(out.estimates[0].params[1]).toMatch(/^0x[0-9a-f]+$/);
      expect(out.sent).toBe(1);
    });

    it("names a Gas Limit too low before sending", {
      timeout: 30_000,
    }, async () => {
      const out = await poke({
        target: await contractWith(STORER_CODE),
        gasLimit: BigInt(30_000),
      });

      expect(isGasLimitError(out.error)).toBe(true);
      expect((out.error as Error).message).toBe(
        "Gas Limit 30000 is too low for this call: the call fails under that limit and passes without one. Raise the Gas Limit or leave it empty."
      );
      expect(out.calls).toBe(0);
      expect(out.sent).toBe(0);
    });

    it("refuses a Gas Limit above the block's before any estimate", {
      timeout: 30_000,
    }, async () => {
      const block = (await anvil("eth_getBlockByNumber", [
        "latest",
        false,
      ])) as {
        gasLimit: string;
      };
      const out = await poke({
        target: await contractWith(STORER_CODE),
        gasLimit: BigInt(block.gasLimit) + BigInt(1),
      });

      expect(isGasLimitError(out.error)).toBe(true);
      expect((out.error as Error).message).toContain(
        "above the network's limit"
      );
      expect(out.estimates).toHaveLength(0);
      expect(out.sent).toBe(0);
    });

    it("checks a plain transfer with eth_estimateGas too", {
      timeout: 30_000,
    }, async () => {
      const { seen, rpc, wallet, adapter } = await setup();
      const nonce = await wallet.getNonce("pending");

      await adapter.sendTransaction(
        wallet,
        { to: DEAD, value: BigInt(1) },
        { currentNonce: nonce } as never,
        { gasOverrides: {}, rpcManager: rpc }
      );

      expect(seen.some((entry) => entry.method === "eth_call")).toBe(false);
      expect(
        seen.filter((entry) => entry.method === "eth_estimateGas")
      ).toHaveLength(1);
      expect((await wallet.getNonce("pending")) - nonce).toBe(1);
    });
  }
);
