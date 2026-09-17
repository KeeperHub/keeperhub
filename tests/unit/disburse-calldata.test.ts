import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// supported_tokens rows the stablecoin ceiling reads, set per test.
const registry = vi.hoisted(() => ({
  tokenRows: [] as Array<{
    tokenAddress: string;
    decimals: number;
    symbol: string;
    isStablecoin: boolean;
  }>,
}));

vi.mock("@/lib/workflow/executor/step-handler", async () =>
  (await import("../mocks/step-mocks")).stepHandlerPassthrough()
);

vi.mock("@/lib/logging", () => ({
  ErrorCategory: {
    VALIDATION: "validation",
    TRANSACTION: "transaction",
  },
  logUserError: vi.fn(),
  logSecurityEvent: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        // The stablecoin ceiling awaits where() directly (it reads the chain's
        // whole token list); other lookups end in limit().
        where: () =>
          Object.assign(Promise.resolve(registry.tokenRows), {
            limit: () => Promise.resolve([]),
          }),
      }),
    }),
    query: {
      explorerConfigs: {
        findFirst: () =>
          Promise.resolve({ chainId: 1, baseUrl: "https://etherscan.io" }),
      },
    },
  },
}));

vi.mock("@/lib/db/schema", () => ({
  workflowExecutions: { id: "id", userId: "userId", workflowId: "workflowId" },
  explorerConfigs: { id: "id", chainId: "chainId" },
  supportedTokens: {
    id: "id",
    chainId: "chainId",
    tokenAddress: "tokenAddress",
    decimals: "decimals",
    symbol: "symbol",
    isStablecoin: "isStablecoin",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: () => ({}),
  and: () => ({}),
  inArray: () => ({}),
}));

vi.mock("@/lib/utils", async () =>
  (await import("../mocks/step-mocks")).utilsGetErrorMessage()
);

vi.mock("@/lib/utils/id", () => ({
  generateId: vi.fn().mockReturnValue("test-unique-id"),
}));

vi.mock("@/lib/rpc/network-utils", () => ({
  getChainIdFromNetwork: vi.fn().mockReturnValue(84_532),
}));

const mockExecuteWithFailover = vi.fn();
vi.mock("@/lib/rpc/provider-factory", () => ({
  isSolanaChain: () => false,
  getRpcProvider: vi.fn().mockImplementation(() =>
    Promise.resolve({
      resolveActiveRpcUrl: vi.fn().mockResolvedValue("https://rpc.example.com"),
      executeWithFailover: mockExecuteWithFailover,
    })
  ),
}));

vi.mock("@/lib/explorer", () => ({
  getTransactionUrl: vi
    .fn()
    .mockReturnValue("https://etherscan.io/tx/0xtxhash"),
  getAddressUrl: vi.fn().mockReturnValue("https://etherscan.io/address/0xabc"),
}));

const mockExecuteContractCall = vi.fn();
const mockGetTransactionUrl = vi.fn();
vi.mock("@/lib/web3/chain-adapter", () => ({
  getChainAdapter: () => ({
    executeContractCall: (...args: unknown[]) =>
      mockExecuteContractCall(...args),
    getTransactionUrl: (...args: unknown[]) => mockGetTransactionUrl(...args),
  }),
}));

vi.mock("@/lib/web3/resolve-org-context", () => ({
  resolveOrganizationContext: vi.fn().mockResolvedValue({
    success: true,
    organizationId: "org-1",
    userId: undefined,
  }),
}));

vi.mock("@/lib/web3/wallet-helpers", () => ({
  getOrganizationWalletAddress: vi.fn().mockResolvedValue("0xWalletAddress"),
  initializeWalletSigner: vi.fn().mockResolvedValue({
    getAddress: () => Promise.resolve("0xWalletAddress"),
    provider: {},
  }),
}));

vi.mock("@/lib/web3/gas-defaults", () => ({
  resolveGasLimitOverrides: () => ({
    multiplierOverride: undefined,
    gasLimitOverride: undefined,
  }),
}));

vi.mock("@/lib/web3/decode-revert-error", () => ({
  classifyRevert: vi.fn().mockReturnValue({ kind: "unknown" }),
  formatContractError: vi.fn().mockReturnValue("contract error"),
}));

vi.mock("@/lib/web3/turnkey-sponsorship-config", () => ({
  isSponsorshipSupported: () => false,
}));

vi.mock("@/lib/web3/sponsorship-feature-flag", () => ({
  isGasSponsorshipEnabled: vi.fn().mockResolvedValue(false),
}));

vi.mock("@/lib/web3/turnkey-revert", () => ({
  isSponsoredTxRevertError: vi.fn().mockReturnValue(false),
}));

vi.mock("@/lib/web3/sponsored-transaction-manager", () => ({
  executeSponsoredContractTransaction: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/safe/signer-resolver", () => ({
  SIGNER_MODE: { EOA: "eoa", SAFE: "safe", SAFE_ROLE: "safe-role" },
  resolveSignerMode: vi
    .fn()
    .mockResolvedValue({ kind: "eoa", ownerAddress: "0xWalletAddress" }),
  resolveSignerForNode: vi
    .fn()
    .mockResolvedValue({ kind: "eoa", ownerAddress: "0xWalletAddress" }),
}));

vi.mock("@/lib/safe/execute-as-safe", () => ({
  executeContractCallAsSafe: vi.fn(),
  executeNativeTransferAsSafe: vi.fn(),
}));

vi.mock("@/lib/web3/transaction-manager", () => ({
  withNonceSession: (
    _ctx: unknown,
    _wallet: unknown,
    fn: (session: unknown) => unknown
  ) => fn({ id: "mock-session" }),
}));

const mockTraceExecutedCall = vi.fn();
vi.mock("@/lib/web3/trace-executed-call", () => ({
  traceExecutedCallWithFailover: (...args: unknown[]) =>
    mockTraceExecutedCall(...args),
}));

vi.mock("ethers", async () => {
  const actual = await vi.importActual<typeof import("ethers")>("ethers");
  return {
    ...actual,
    ethers: {
      ...actual.ethers,
      Contract: class MockContract {
        decimals = vi.fn().mockResolvedValue(BigInt(6));
        symbol = vi.fn().mockResolvedValue("USDC");
        balanceOf = vi.fn().mockResolvedValue(BigInt("1000000000000000"));
        interface = {};
        transfer = Object.assign(vi.fn(), {
          staticCall: vi.fn().mockResolvedValue(true),
          estimateGas: vi.fn().mockResolvedValue(BigInt(46_000)),
        });
      },
    },
  };
});

vi.mock("@/lib/execute/value-ledger", () => ({
  withStepValueCap: (_args: unknown, run: () => unknown) => run(),
}));
vi.mock("@/plugins/web3/steps/transfer-funds-core", () => ({
  transferFundsCore: () => Promise.reject(new Error("not used")),
}));
vi.mock("@/plugins/web3/steps/transfer-spl-token-core", () => ({
  transferSplTokenCore: () => Promise.reject(new Error("not used")),
}));

// An in-memory ledger: this file is about what goes on the wire, not the SQL
// (tests/db/disburse-resume.db.test.ts covers that).
vi.mock("@/lib/web3/disbursement-ledger", () => ({
  readRunLegs: () => Promise.resolve([]),
  readReceiptRecords: () => Promise.resolve(new Map()),
  claimNewLeg: () => Promise.resolve("token"),
  reclaimLeg: () => Promise.resolve("token"),
  recordBroadcastEvent: () => Promise.resolve(),
  recordOutcome: () => Promise.resolve(),
  applyReceiptVerdict: () => Promise.resolve(false),
}));

/**
 * Golden calldata for web3/disburse ERC-20 legs.
 *
 * Runs the real disburse core through the real transfer-token core and
 * captures what reaches the chain adapter, then encodes it with the ABI the
 * core sent. A change to amount scaling, argument order, the token target or
 * the ABI shows up as a diff against the checked-in file.
 *
 * Regenerate after an intentional change:
 *   UPDATE_GOLDENS=1 pnpm vitest run tests/unit/disburse-calldata.test.ts
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ethers as realEthers } from "ethers";
import { disburseCore } from "@/plugins/web3/steps/disburse-core";

const GOLDEN = join(
  import.meta.dirname,
  "__goldens__",
  "disburse-calldata.json"
);
const UPDATE = process.env.UPDATE_GOLDENS === "1";

const TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const LEGS = [
  { recipient: "0x106175F175B940CcA1816d75eB19937a88BE7720", amount: "1" },
  { recipient: "0x9cBa0Ef1D7CC6B78e46F060F551D175DA45Aa98a", amount: "0.5" },
  {
    recipient: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    amount: "1234.567891",
  },
];

type Golden = Array<{ legIndex: number; to: string; data: string }>;

beforeEach(() => {
  vi.clearAllMocks();
  mockExecuteWithFailover.mockImplementation(
    (fn: (provider: unknown) => unknown) => fn({})
  );
  mockGetTransactionUrl.mockResolvedValue("https://example/tx");
  mockTraceExecutedCall.mockResolvedValue(undefined);
});

describe("disburse ERC-20 calldata golden", () => {
  it("sends each leg as transfer(recipient, amount in token units) to the token", async () => {
    const captured: Golden = [];
    let leg = 0;
    mockExecuteContractCall.mockImplementation(
      async (
        _signer: unknown,
        request: {
          contractAddress: string;
          abi: realEthers.InterfaceAbi;
          functionKey: string;
          args: unknown[];
        },
        _session: unknown,
        options: { beforeBroadcast?: (e: unknown) => Promise<void> }
      ) => {
        const iface = new realEthers.Interface(request.abi);
        captured.push({
          legIndex: leg,
          to: request.contractAddress,
          data: iface.encodeFunctionData(request.functionKey, request.args),
        });
        const hash = `0x${String(leg).padStart(64, "0")}`;
        leg += 1;
        await options.beforeBroadcast?.({
          kind: "evm-signed",
          transactionHash: hash,
        });
        return {
          hash,
          gasUsed: BigInt(50_000),
          effectiveGasPrice: BigInt(1),
          blockNumber: 1,
        };
      }
    );

    const result = await disburseCore({
      network: "base-sepolia",
      assetType: "erc20",
      tokenAddress: TOKEN,
      runKey: "golden",
      legs: LEGS,
      _context: {
        organizationId: "org-1",
        nodeId: "disburse-1",
        nodeName: "Disburse",
        nodeType: "web3/disburse",
      },
    });

    expect(result.success).toBe(true);
    if (UPDATE || !existsSync(GOLDEN)) {
      if (!UPDATE) {
        throw new Error(`missing golden ${GOLDEN}; run with UPDATE_GOLDENS=1`);
      }
      writeFileSync(GOLDEN, `${JSON.stringify(captured, null, 2)}\n`);
    }
    const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as Golden;
    expect(captured).toEqual(golden);
    // The selector is transfer(address,uint256), never transferFrom.
    for (const entry of golden) {
      expect(entry.data.slice(0, 10)).toBe("0xa9059cbb");
    }
  });
});
