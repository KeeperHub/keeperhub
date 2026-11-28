import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/sleep", () => ({ sleep: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/logging", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/logging")>()),
  logSystemError: vi.fn(),
  logSystemWarn: vi.fn(),
  logUserError: vi.fn(),
  logWarn: vi.fn(),
}));
vi.mock("@/lib/workflow/executor/step-handler", async () =>
  (await import("../mocks/step-mocks")).stepHandlerPassthrough()
);
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/workflow/executor/helpers", () => ({
  getRpcPreferenceUserId: () => Promise.resolve("user-1"),
}));
vi.mock("@/lib/web3/explorer-link", () => ({
  resolveExplorerLink: () => Promise.resolve(undefined),
}));
vi.mock("@/lib/rpc/network-utils", () => ({
  getChainIdFromNetwork: () => 1,
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
const { rpc } = vi.hoisted(() => ({ rpc: { userRpc: true, url: "" } }));
vi.mock("@/lib/rpc/provider-factory", async () => {
  const { RpcProviderManager } = await import("@/lib/rpc/providers");
  return {
    getRpcProvider: () =>
      Promise.resolve(
        new RpcProviderManager({
          config: {
            primaryRpcUrl: rpc.url,
            fallbackRpcUrl: `${rpc.url}/other`,
            maxRetries: 1,
            chainName: "Ethereum",
            chainId: 1,
            userRpc: rpc.userRpc,
          },
        })
      ),
    isSolanaChain: () => false,
  };
});

// Send as Bundle: only the bundle's own pre-send read goes out, on the step's RPC.
vi.mock("@/lib/web3/bundles/in-flight", () => ({
  bundleInFlight: () => Promise.resolve({ kind: "none" }),
}));
vi.mock("@/lib/web3/gas-preflight", () => ({
  preflightGasBalance: () => Promise.resolve({ affordable: true }),
}));
vi.mock("@/lib/web3/transaction-manager", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/web3/transaction-manager")>()),
  withNonceSession: (
    _context: unknown,
    _wallet: string,
    fn: (session: unknown) => Promise<unknown>
  ) => fn({ currentNonce: 1 }),
}));
vi.mock("@/lib/web3/wallet-helpers", () => ({
  initializeWalletSigner: () => Promise.resolve({}),
}));
vi.mock("@/lib/web3/bundles/send-bundle", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/web3/bundles/send-bundle")>()),
  sendBundleInSession: (input: {
    rpcManager: { executeWithFailover: (op: unknown) => Promise<unknown> };
  }) =>
    input.rpcManager.executeWithFailover(
      (provider: { getTransactionCount: (a: string) => Promise<number> }) =>
        provider.getTransactionCount(`0x${"aa".repeat(20)}`)
    ),
}));

import {
  applyErrorClassHint,
  classifyExecutionError,
} from "@/lib/errors/classify";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import { ErrorCategory } from "@/lib/logging";
import { getRpcProvider } from "@/lib/rpc/provider-factory";
import { batchReadContractStep } from "@/plugins/web3/steps/batch-read-contract";
import { checkAllowanceStep } from "@/plugins/web3/steps/check-allowance";
import { checkBalanceStep } from "@/plugins/web3/steps/check-balance";
import { checkTokenBalanceStep } from "@/plugins/web3/steps/check-token-balance";
import { getNonceStep } from "@/plugins/web3/steps/get-nonce";
import { getTransactionStep } from "@/plugins/web3/steps/get-transaction";
import { queryEventsStep } from "@/plugins/web3/steps/query-events";
import { writeAsBundle } from "@/plugins/web3/steps/write-contract-bundle";

const ADDRESS = "0x742d35Cc6634C0532925a3b844Bc454e4438f44e";
const TOKEN = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const TRANSFER_ABI = JSON.stringify([
  {
    type: "event",
    name: "Transfer",
    anonymous: false,
    inputs: [
      { indexed: true, name: "from", type: "address" },
      { indexed: true, name: "to", type: "address" },
      { indexed: false, name: "value", type: "uint256" },
    ],
  },
]);
const BALANCE_ABI = JSON.stringify([
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
]);

type StepResult = { success: boolean; error?: string; errorClass?: unknown };

// Every read the step itself makes is redirected; the chain id and head answer.
const STEPS: [string, () => Promise<unknown>][] = [
  [
    "Check Balance",
    () => checkBalanceStep({ network: "ethereum", address: ADDRESS }),
  ],
  [
    "Check Token Balance",
    () =>
      checkTokenBalanceStep({
        network: "ethereum",
        address: ADDRESS,
        tokenConfig: JSON.stringify({
          mode: "custom",
          customToken: { address: TOKEN, symbol: "DAI" },
        }),
      }),
  ],
  [
    "Check Allowance",
    () =>
      checkAllowanceStep({
        network: "ethereum",
        tokenConfig: TOKEN,
        tokenAddress: TOKEN,
        ownerAddress: ADDRESS,
        spenderAddress: ADDRESS,
      }),
  ],
  [
    "Get Transaction",
    () =>
      getTransactionStep({
        network: "ethereum",
        transactionHash: `0x${"ab".repeat(32)}`,
      }),
  ],
  ["Get Nonce", () => getNonceStep({ network: "ethereum", address: ADDRESS })],
  [
    "Query Events",
    () =>
      queryEventsStep({
        network: "ethereum",
        contractAddress: TOKEN,
        abi: TRANSFER_ABI,
        eventName: "Transfer",
        blockCount: 10,
      }),
  ],
  [
    "Query Events (multiple)",
    () =>
      queryEventsStep({
        network: "ethereum",
        queryMode: "multiple",
        eventQueries: [
          { contractAddress: TOKEN, abi: TRANSFER_ABI, eventName: "Transfer" },
        ],
        blockCount: 10,
      }),
  ],
  [
    "Batch Read Contract",
    () =>
      batchReadContractStep({
        network: "ethereum",
        contractAddress: TOKEN,
        abi: BALANCE_ABI,
        abiFunction: "balanceOf",
        argsList: JSON.stringify([[ADDRESS]]),
      }),
  ],
];

// Write Contract sent as a bundle, failing on a read before sending.
async function bundleBeforeSending(): Promise<unknown> {
  return await writeAsBundle({
    route: {
      settings: { blocks: 1, tipIncreasePercent: 0 },
      builders: [],
      unknownBuilders: [],
      workflowId: "wf-1",
      executionId: "exec-1",
      node: { id: "write-1", name: "Write" },
    } as never,
    chainId: 1,
    organizationId: "org-1",
    walletAddress: `0x${"aa".repeat(20)}`,
    rpcUrl: rpc.url,
    rpcManager: await getRpcProvider({ chainId: 1 } as never),
    traceExecuted: () => Promise.resolve(undefined),
    txContext: {} as never,
    contractAddress: TOKEN,
    parsedAbi: JSON.parse(BALANCE_ABI) as unknown[],
    abiFunction: "balanceOf",
    functionKey: "balanceOf",
    args: [ADDRESS],
    gas: {},
  });
}

const ANSWERED: Record<string, string> = {
  eth_chainId: "0x1",
  eth_blockNumber: "0x100",
};

let server: Server;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const { id, method } = JSON.parse(body) as { id: number; method: string };
      const result = ANSWERED[method];
      if (result === undefined) {
        res.statusCode = 307;
        res.setHeader("location", "https://elsewhere.example/");
        res.end();
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve())
  );
  rpc.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

function classified(result: StepResult) {
  return applyErrorClassHint(
    classifyExecutionError(result.error),
    result.errorClass as ExecutionErrorType | undefined
  );
}

describe("a redirecting RPC keeps its fault domain through each step's wrapper", () => {
  it.each(STEPS)("%s: the user's own RPC preference", async (_name, run) => {
    rpc.userRpc = true;
    const result = (await run()) as StepResult;

    expect(result.success).toBe(false);
    expect(result.error).toContain(
      "Your RPC preference for Ethereum answered with a redirect, which is not followed; set it to the final https:// address"
    );
    expect(result.errorClass).toBe(ExecutionErrorType.USER);
    expect(classified(result)).toEqual({
      errorCategory: ErrorCategory.CONFIGURATION,
      errorType: ExecutionErrorType.USER,
      code: null,
    });
  });

  it.each(STEPS)(
    "%s: a platform URL stays a platform fault",
    async (_name, run) => {
      rpc.userRpc = false;
      const result = (await run()) as StepResult;

      expect(result.success).toBe(false);
      expect(result.error).toContain("redirect");
      expect(result.errorClass).toBeUndefined();
      expect(classified(result)).toMatchObject({
        errorType: ExecutionErrorType.SYSTEM,
        code: "N-0001",
      });
    }
  );
});

describe("Send as Bundle keeps the class of a read before sending", () => {
  it("the user's own RPC preference: their fault, with the fix", async () => {
    rpc.userRpc = true;
    const result = (await bundleBeforeSending()) as StepResult & {
      broadcastAttempted?: boolean;
    };

    expect(result.success).toBe(false);
    expect(result.broadcastAttempted).toBe(false);
    expect(result.error).toContain(
      "Your RPC preference for Ethereum answered with a redirect, which is not followed; set it to the final https:// address"
    );
    expect(result.errorClass).toBe(ExecutionErrorType.USER);
    expect(classified(result).errorType).toBe(ExecutionErrorType.USER);
  });

  it("a platform URL declares no class", async () => {
    rpc.userRpc = false;
    const result = (await bundleBeforeSending()) as StepResult;

    expect(result.success).toBe(false);
    expect(result.error).toContain("redirect");
    expect(result.errorClass).toBeUndefined();
  });
});
