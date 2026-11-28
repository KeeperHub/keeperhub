/**
 * E2E: Transfer ERC20 Token and Approve ERC20 Token with Send as = Private
 * relay, through a relay that refuses eth_call (as Flashbots Protect does).
 * The token lookups (decimals, symbol, balanceOf) go to the chain's regular
 * RPC; the transaction, its pre-send check and its send stay on the relay.
 * Real cores, provider factory, RPC config (the relay swap), readRpcFor,
 * ethers, RpcProviderManager and EvmChainAdapter. Stubbed: the database rows,
 * the wallet, the organisation, the nonce lock and the gas strategy. The fake
 * relay allows exactly the methods Flashbots Protect was seen to allow.
 *
 * Prerequisite: anvil on 127.0.0.1:8546 (chain id 31337). Skipped when
 * SKIP_INFRA_TESTS=true or anvil is not reachable.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { ethers } from "ethers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const ANVIL_URL = process.env.ANVIL_URL ?? "http://127.0.0.1:8546";
const CHAIN_ID = 31_337;

type Seen = { method: string; params: unknown[] }[];

const env = vi.hoisted(() => ({
  relay: { url: "", seen: [] as { method: string; params: unknown[] }[] },
  public: { url: "", seen: [] as { method: string; params: unknown[] }[] },
  wallet: null as unknown as import("ethers").Wallet,
}));

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

vi.mock("server-only", () => ({}));
vi.mock("@/keeperhub-executor/lib/broadcast-marker", () => ({
  markBroadcast: vi.fn(),
}));
vi.mock("@/lib/logging", () => ({
  ErrorCategory: new Proxy({}, { get: (_target, key) => String(key) }),
  logSystemError: vi.fn(),
  logSystemWarn: vi.fn(),
  logUserError: vi.fn(),
  logSecurityEvent: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logDebug: vi.fn(),
}));
vi.mock("@/lib/db", async () => {
  const schema = await import("@/lib/db/schema");
  // The chain row resolveRpcConfig reads; no user RPC preferences.
  const rowsFor = (table: unknown) =>
    table === schema.chains
      ? [
          {
            chainId: 31_337,
            name: "anvil",
            isEnabled: true,
            defaultPrimaryRpc: env.public.url,
            defaultFallbackRpc: null,
            defaultPrimaryWss: null,
            defaultFallbackWss: null,
            defaultPrivateRpcUrl: env.relay.url,
            usePrivateMempoolRpc: true,
            broadcastRpcUrls: [],
          },
        ]
      : [];
  return {
    db: {
      query: {
        explorerConfigs: { findFirst: () => Promise.resolve(undefined) },
      },
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({ limit: () => Promise.resolve(rowsFor(table)) }),
        }),
      }),
    },
  };
});
vi.mock("@/lib/redis-cache", () => ({
  cachedRead: ({ read }: { read: () => Promise<unknown> }) => read(),
}));
vi.mock("@/lib/rpc/network-utils", () => ({
  getChainIdFromNetwork: () => 31_337,
}));
vi.mock("@/lib/execute/stablecoin-cap", () => ({
  checkStablecoinTransferAmount: () => Promise.resolve({ kind: "allowed" }),
  checkStablecoinContractCall: () => Promise.resolve({ kind: "allowed" }),
}));
vi.mock("@/lib/web3/resolve-org-context", () => ({
  resolveOrganizationContext: () =>
    Promise.resolve({ success: true, organizationId: "org-1", userId: "u1" }),
}));
vi.mock("@/lib/web3/wallet-helpers", () => ({
  getOrganizationWalletAddress: () => Promise.resolve(env.wallet.address),
  initializeWalletSigner: (_org: string, rpcUrl: string) =>
    Promise.resolve(
      env.wallet.connect(
        new ethers.JsonRpcProvider(rpcUrl, 31_337, { staticNetwork: true })
      )
    ),
}));
vi.mock("@/lib/safe/signer-resolver", () => ({
  SIGNER_MODE: { EOA: "eoa", SAFE: "safe", SAFE_ROLE: "safe-role" },
  resolveSignerForNode: () =>
    Promise.resolve({ kind: "eoa", ownerAddress: env.wallet.address }),
}));
vi.mock("@/lib/safe/execute-as-safe", () => ({
  executeContractCallAsSafe: vi.fn(),
  executeContractCallAsRole: vi.fn(),
}));
vi.mock("@/lib/web3/sponsored-transaction-manager", () => ({
  executeSponsoredContractTransaction: vi.fn(),
}));
vi.mock("@/lib/web3/transaction-manager", () => ({
  withNonceSession: async (
    _ctx: unknown,
    address: string,
    fn: (session: unknown) => unknown
  ) =>
    fn({
      currentNonce: await new ethers.JsonRpcProvider(
        ANVIL_URL
      ).getTransactionCount(address, "pending"),
    }),
}));
vi.mock("@/lib/web3/chain-adapter", async () => {
  const { EvmChainAdapter } = await import("@/lib/web3/chain-adapter/evm");
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
    recordTransaction: () => Promise.resolve(),
    confirmTransaction: () => Promise.resolve(),
  };
  return {
    getChainAdapter: () =>
      new EvmChainAdapter(31_337, gasStrategy as never, nonceManager as never),
  };
});

import { approveTokenCore } from "@/plugins/web3/steps/approve-token-core";
import { transferTokenCore } from "@/plugins/web3/steps/transfer-token-core";

// A toy token: symbol() returns "TKN"; every other call returns 18, so
// decimals() is 18, balanceOf() is 18 base units, transfer/approve are true.
const TOKEN_CODE =
  "0x60003560e01c6395d89b4114601957601260005260206000f35b6020600052600360205262544b4e60e81b60405260606000f3";
const READ_SELECTORS = ["0x313ce567", "0x95d89b41", "0x70a08231"];
const WRITE_SELECTORS = ["0xa9059cbb", "0x095ea7b3"];
const RECIPIENT = "0x000000000000000000000000000000000000dEaD";

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

const servers: http.Server[] = [];

type ProxyMode = { relay: boolean; chainId?: string };

/**
 * A recording proxy to anvil. As a relay it refuses every method outside
 * RELAY_ALLOWED the way Flashbots Protect does, and can claim another chain.
 */
async function proxy(seen: Seen, mode: ProxyMode): Promise<string> {
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
      if (mode.chainId && calls[0].method === "eth_chainId") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: calls[0].id,
            result: mode.chainId,
          })
        );
        return;
      }
      if (mode.relay && calls.some((call) => !RELAY_ALLOWED.has(call.method))) {
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

function dataOf(entry: { params: unknown[] }): string {
  const first = entry.params[0];
  if (typeof first === "string") {
    return first;
  }
  return String((first as { data?: string; input?: string })?.data ?? "");
}

async function freshRun(relayChainId?: string): Promise<string> {
  env.relay.seen = [];
  env.public.seen = [];
  env.relay.url = await proxy(env.relay.seen, {
    relay: true,
    chainId: relayChainId,
  });
  env.public.url = await proxy(env.public.seen, { relay: false });
  env.wallet = ethers.Wallet.createRandom() as unknown as ethers.Wallet;
  await anvil("anvil_setBalance", [env.wallet.address, "0xDE0B6B3A7640000"]);
  const token = ethers.Wallet.createRandom().address;
  await anvil("anvil_setCode", [token, TOKEN_CODE]);
  return token;
}

function expectRelayOnlySend(): void {
  const relayMethods = env.relay.seen.map((entry) => entry.method);
  const publicMethods = env.public.seen.map((entry) => entry.method);
  // The relay only gets methods it allows; it does the check and the send.
  expect(relayMethods.filter((method) => !RELAY_ALLOWED.has(method))).toEqual(
    []
  );
  expect(relayMethods).toContain("eth_estimateGas");
  expect(relayMethods).toContain("eth_sendRawTransaction");
  // The regular RPC gets only the token lookups and the trace of the mined
  // transaction: never the signed transaction, nor calldata before the send.
  expect(publicMethods).toContain("eth_call");
  expect(publicMethods).not.toContain("eth_sendRawTransaction");
  for (const entry of env.public.seen.filter(
    (e) => e.method !== "debug_traceTransaction"
  )) {
    const data = dataOf(entry);
    for (const selector of WRITE_SELECTORS) {
      expect(data.includes(selector.slice(2))).toBe(false);
    }
  }
  for (const entry of env.public.seen.filter((e) => e.method === "eth_call")) {
    expect(READ_SELECTORS).toContain(dataOf(entry).slice(0, 10));
  }
}

// The proxies and anvil are on loopback, which safeFetch blocks outside shadow mode.
beforeAll(() => {
  vi.stubEnv("SAFE_FETCH_SHADOW", "true");
});

afterAll(async () => {
  vi.unstubAllEnvs();
  // Let reads still in flight after the last step settle before closing.
  await new Promise((resolve) => setTimeout(resolve, 2000));
  for (const server of servers) {
    server.closeAllConnections();
    server.close();
  }
});

describe.skipIf(shouldSkip)(
  "ERC20 steps through a strict private relay (anvil E2E)",
  () => {
    it("transfers, with the token lookups off the relay", {
      timeout: 60_000,
    }, async () => {
      const token = await freshRun();

      const result = await transferTokenCore({
        network: "31337",
        tokenConfig: token,
        recipientAddress: RECIPIENT,
        amount: "0.000000000000000001",
        sendMode: "private-relay",
        sponsorGas: false,
        _context: { organizationId: "org-1", executionId: "exec-1" },
      } as never);

      expect(result).toMatchObject({ success: true, symbol: "TKN" });
      expectRelayOnlySend();
    });

    it("approves, with the token lookups off the relay", {
      timeout: 60_000,
    }, async () => {
      const token = await freshRun();

      const result = await approveTokenCore({
        network: "31337",
        tokenConfig: token,
        spenderAddress: RECIPIENT,
        amount: "1",
        usePrivateMempool: true,
        sponsorGas: false,
        _context: { organizationId: "org-1", executionId: "exec-2" },
      } as never);

      expect(result).toMatchObject({ success: true });
      expectRelayOnlySend();
    });

    it("sends the same way with strict: false", {
      timeout: 60_000,
    }, async () => {
      const token = await freshRun();

      const result = await transferTokenCore({
        network: "31337",
        tokenConfig: token,
        recipientAddress: RECIPIENT,
        amount: "0.000000000000000001",
        sendMode: "private-relay",
        strict: false,
        sponsorGas: false,
        _context: { organizationId: "org-1", executionId: "exec-4" },
      } as never);

      expect(result).toMatchObject({ success: true });
      expectRelayOnlySend();
    });

    it("refuses a relay that serves another chain before sending", {
      timeout: 60_000,
    }, async () => {
      const token = await freshRun("0x1");

      const result = await transferTokenCore({
        network: "31337",
        tokenConfig: token,
        recipientAddress: RECIPIENT,
        amount: "0.000000000000000001",
        sendMode: "private-relay",
        sponsorGas: false,
        _context: { organizationId: "org-1", executionId: "exec-5" },
      } as never);

      expect(result).toMatchObject({ success: false, errorClass: "user" });
      expect((result as { error: string }).error).toContain(
        "serves chain 1, not 31337"
      );
      expect(env.relay.seen.map((entry) => entry.method)).toEqual([
        "eth_chainId",
      ]);
      expect(env.public.seen).toEqual([]);
    });

    it("still sends a normal transfer through the regular RPC alone", {
      timeout: 60_000,
    }, async () => {
      const token = await freshRun();

      const result = await transferTokenCore({
        network: "31337",
        tokenConfig: token,
        recipientAddress: RECIPIENT,
        amount: "0.000000000000000001",
        sponsorGas: false,
        _context: { organizationId: "org-1", executionId: "exec-3" },
      } as never);

      expect(result).toMatchObject({ success: true });
      expect(env.relay.seen).toEqual([]);
      expect(env.public.seen.map((entry) => entry.method)).toContain(
        "eth_sendRawTransaction"
      );
    });
  }
);
