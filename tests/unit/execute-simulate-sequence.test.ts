import { ethers } from "ethers";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const FROM = "0xaa0000000000000000000000000000000000aa00";
const TOKEN = "0xbb0000000000000000000000000000000000bb00";
const VAULT = "0xcc0000000000000000000000000000000000cc00";

const spies = vi.hoisted(() => ({
  send: vi.fn(),
  getChainIdFromNetwork: vi.fn(),
  getOrganizationWalletAddress: vi.fn(),
  getRpcProvider: vi.fn(),
  isSolanaChain: vi.fn(),
  chainsLookup: vi.fn(() => Promise.resolve([{ symbol: "ETH" }])),
  supportedTokensLookup: vi.fn(() => Promise.resolve([] as unknown[])),
}));

vi.mock("@/lib/web3/wallet-helpers", () => ({
  getOrganizationWalletAddress: spies.getOrganizationWalletAddress,
}));

vi.mock("@/lib/rpc/network-utils", () => ({
  getChainIdFromNetwork: spies.getChainIdFromNetwork,
}));

vi.mock("@/lib/rpc/provider-factory", () => ({
  getRpcProvider: spies.getRpcProvider,
  isSolanaChain: spies.isSolanaChain,
}));

vi.mock("@/plugins/web3/steps/transfer-token-core", () => ({
  parseTokenAddress: vi.fn(),
}));

vi.mock("@/lib/logging", () => ({
  logSystemError: vi.fn(),
  ErrorCategory: { DATABASE: "database" },
  logSecurityEvent: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => {
          const pending = Promise.resolve(
            spies.supportedTokensLookup()
          ) as Promise<unknown> & { limit: () => unknown };
          pending.limit = () => spies.chainsLookup();
          return pending;
        },
      }),
    }),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  chains: { chainId: "chain_id", symbol: "symbol" },
  supportedTokens: {
    chainId: "chain_id",
    tokenAddress: "token_address",
    decimals: "decimals",
    symbol: "symbol",
    isStablecoin: "is_stablecoin",
  },
}));

import {
  mergeDiffIntoOverridesForTests,
  resetSequenceMechanismCache,
  simulateCallSequence,
} from "@/lib/execute/simulate-sequence";

const ERC20_ABI = JSON.stringify([
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
]);

const VAULT_ABI = JSON.stringify([
  {
    type: "function",
    name: "deposit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "assets", type: "uint256" },
      { name: "receiver", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
]);

const APPROVE_THEN_DEPOSIT = [
  {
    contractAddress: TOKEN,
    abi: ERC20_ABI,
    functionName: "approve",
    functionArgs: JSON.stringify([VAULT, "1000"]),
  },
  {
    contractAddress: VAULT,
    abi: VAULT_ABI,
    functionName: "deposit",
    functionArgs: JSON.stringify(["1000", FROM]),
  },
];

const uint256 = (n: bigint) =>
  ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [n]);
const TRUE = ethers.AbiCoder.defaultAbiCoder().encode(["bool"], [true]);

/** ERC20: transfer amount exceeds allowance, as a node returns it. */
const ALLOWANCE_REVERT = ethers.AbiCoder.defaultAbiCoder()
  .encode(["string"], ["ERC20: transfer amount exceeds allowance"])
  .replace("0x", "0x08c379a0");

function run(calls = APPROVE_THEN_DEPOSIT) {
  return simulateCallSequence({
    organizationId: "org_test",
    network: "84532",
    calls,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetSequenceMechanismCache();
  spies.getOrganizationWalletAddress.mockResolvedValue(FROM);
  spies.getChainIdFromNetwork.mockReturnValue(84_532);
  spies.isSolanaChain.mockReturnValue(false);
  spies.supportedTokensLookup.mockResolvedValue([]);
  spies.getRpcProvider.mockResolvedValue({
    executeWithFailover: (operation: (p: unknown) => unknown) =>
      operation({ send: spies.send }),
  });
});

describe("simulateCallSequence over eth_simulateV1", () => {
  it("sends every call in one request and reports one result each", async () => {
    spies.send.mockResolvedValueOnce([
      {
        calls: [
          { status: "0x1", gasUsed: "0xd881", returnData: TRUE },
          { status: "0x1", gasUsed: "0x7aeb", returnData: uint256(BigInt(7)) },
        ],
      },
    ]);

    const result = await run();

    expect(spies.send).toHaveBeenCalledTimes(1);
    const [method, params] = spies.send.mock.calls[0];
    expect(method).toBe("eth_simulateV1");
    expect(params[0].blockStateCalls[0].calls).toHaveLength(2);
    expect(params[0].blockStateCalls[0].calls[0]).toMatchObject({
      from: FROM,
      to: TOKEN,
    });
    expect(params[0].validation).toBe(false);

    expect(result.mechanism).toBe("eth_simulateV1");
    expect(result.success).toBe(true);
    expect(result.wouldRevert).toBe(false);
    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toMatchObject({
      success: true,
      gasEstimate: "55425",
    });
    expect(result.results[1]).toMatchObject({
      success: true,
      simulatedReturnValue: "7",
    });
  });

  it("says the sequence is not atomic", async () => {
    spies.send.mockResolvedValueOnce([
      { calls: [{ status: "0x1", gasUsed: "0x1", returnData: "0x" }] },
    ]);

    const result = await run([APPROVE_THEN_DEPOSIT[0]]);

    expect(result.atomic).toBe(false);
  });

  it("decodes a revert and still reports the calls around it", async () => {
    spies.send.mockResolvedValueOnce([
      {
        calls: [
          {
            status: "0x0",
            gasUsed: "0x8e03",
            returnData: "0x",
            error: {
              code: 3,
              data: ALLOWANCE_REVERT,
              message:
                "execution reverted: ERC20: transfer amount exceeds allowance",
            },
          },
          { status: "0x1", gasUsed: "0x7aeb", returnData: uint256(BigInt(0)) },
        ],
      },
    ]);

    const result = await run();

    expect(result.success).toBe(false);
    expect(result.wouldRevert).toBe(true);
    expect(result.results[0]).toMatchObject({
      success: false,
      wouldRevert: true,
      failureKind: "revert",
    });
    // Formatted by decodeRevertReason, the same helper and wording the
    // single-call path produces for the same revert.
    expect(
      (result.results[0] as { revertReason: string }).revertReason
    ).toContain("ERC20: transfer amount exceeds allowance");
    expect(result.results[1]).toMatchObject({ success: true });
  });

  it("marks calls the node answered nothing for rather than inventing a result", async () => {
    spies.send.mockResolvedValueOnce([
      { calls: [{ status: "0x1", gasUsed: "0x1", returnData: TRUE }] },
    ]);

    const result = await run();

    expect(result.results).toHaveLength(2);
    expect(result.results[1]).toMatchObject({
      success: false,
      failureKind: "unavailable",
      wouldRevert: false,
    });
  });
});

describe("simulateCallSequence on a node without eth_simulateV1", () => {
  function fallbackNode() {
    spies.send.mockImplementation((method: string, params: unknown[]) => {
      if (method === "eth_simulateV1") {
        return Promise.reject(
          new Error("the method eth_simulateV1 does not exist")
        );
      }
      if (method === "eth_call") {
        return Promise.resolve(TRUE);
      }
      if (method === "eth_estimateGas") {
        return Promise.resolve("0x5208");
      }
      if (method === "debug_traceCall") {
        return Promise.resolve({
          post: {
            [TOKEN]: { storage: { "0xslot": "0xvalue" }, nonce: 3 },
          },
        });
      }
      return Promise.reject(
        new Error(`unexpected ${method} ${String(params)}`)
      );
    });
  }

  it("replays each call's state diff as an override for the next one", async () => {
    fallbackNode();

    const result = await run();

    expect(result.mechanism).toBe("state-overrides");
    expect(result.success).toBe(true);

    const calls = spies.send.mock.calls.filter(([m]) => m === "eth_call");
    expect(calls).toHaveLength(2);
    // The first call sees latest state; the second sees what the first wrote.
    expect(calls[0][1][2]).toEqual({});
    expect(calls[1][1][2]).toEqual({
      [TOKEN]: { stateDiff: { "0xslot": "0xvalue" }, nonce: "0x3" },
    });
  });

  it("carries a slot cleared to zero so a later call does not see the stale value", async () => {
    const SLOT =
      "0x1111111111111111111111111111111111111111111111111111111111111111";
    const NON_ZERO =
      "0x00000000000000000000000000000000000000000000000000000000000003e8";
    const ZERO =
      "0x0000000000000000000000000000000000000000000000000000000000000000";
    let traceN = 0;
    spies.send.mockImplementation((method: string, params: unknown[]) => {
      if (method === "eth_simulateV1") {
        return Promise.reject(
          new Error("the method eth_simulateV1 does not exist")
        );
      }
      if (method === "eth_call") {
        return Promise.resolve(TRUE);
      }
      if (method === "eth_estimateGas") {
        return Promise.resolve("0x5208");
      }
      if (method === "debug_traceCall") {
        traceN += 1;
        if (traceN === 1) {
          // approve: write non-zero allowance into the accumulator
          return Promise.resolve({
            pre: { [TOKEN]: { storage: {} } },
            post: {
              [TOKEN]: { storage: { [SLOT]: NON_ZERO }, nonce: 3 },
            },
          });
        }
        // deposit: geth omits the zeroed slot from post.storage
        return Promise.resolve({
          pre: { [TOKEN]: { storage: { [SLOT]: NON_ZERO } } },
          post: { [TOKEN]: { storage: {}, nonce: 4 } },
        });
      }
      return Promise.reject(
        new Error(`unexpected ${method} ${String(params)}`)
      );
    });

    const three = [
      ...APPROVE_THEN_DEPOSIT,
      {
        contractAddress: VAULT,
        abi: VAULT_ABI,
        functionName: "deposit",
        functionArgs: JSON.stringify(["1000", FROM]),
      },
    ];
    const result = await run(three);

    expect(result.mechanism).toBe("state-overrides");
    expect(result.success).toBe(true);

    const calls = spies.send.mock.calls.filter(([m]) => m === "eth_call");
    expect(calls).toHaveLength(3);
    // Third call must see the cleared allowance, not the approve-era value.
    expect(calls[2][1][2]).toEqual({
      [TOKEN]: { stateDiff: { [SLOT]: ZERO }, nonce: "0x4" },
    });
  });

  it("does not retry eth_simulateV1 for that chain again", async () => {
    fallbackNode();

    await run();
    const firstAttempts = spies.send.mock.calls.filter(
      ([m]) => m === "eth_simulateV1"
    ).length;
    await run();
    const totalAttempts = spies.send.mock.calls.filter(
      ([m]) => m === "eth_simulateV1"
    ).length;

    expect(firstAttempts).toBe(1);
    expect(totalAttempts).toBe(1);
  });

  it("stops rather than answering as if the earlier call never ran", async () => {
    spies.send.mockImplementation((method: string) => {
      if (method === "eth_simulateV1") {
        return Promise.reject(new Error("method not found"));
      }
      if (method === "eth_call") {
        return Promise.resolve(TRUE);
      }
      if (method === "eth_estimateGas") {
        return Promise.resolve("0x5208");
      }
      return Promise.reject(new Error("prestateTracer is not supported"));
    });

    const result = await run();

    expect(result.results[0]).toMatchObject({ success: true });
    expect(result.results[1]).toMatchObject({
      success: false,
      failureKind: "unavailable",
    });
  });

  it("keeps a node error that is not a missing method as unavailable", async () => {
    spies.send.mockRejectedValue(new Error("connection reset"));

    const result = await run();

    expect(result.mechanism).toBeNull();
    expect(result.results).toHaveLength(2);
    for (const call of result.results) {
      expect(call).toMatchObject({
        success: false,
        failureKind: "unavailable",
      });
    }
    expect(
      spies.send.mock.calls.filter(([m]) => m === "eth_call")
    ).toHaveLength(0);
  });
});

describe("mergeDiffIntoOverrides cleared storage slots", () => {
  const ZERO =
    "0x0000000000000000000000000000000000000000000000000000000000000000";
  const SLOT =
    "0x1111111111111111111111111111111111111111111111111111111111111111";
  const OTHER =
    "0x2222222222222222222222222222222222222222222222222222222222222222";
  const NON_ZERO =
    "0x00000000000000000000000000000000000000000000000000000000000003e8";
  const LATER =
    "0x0000000000000000000000000000000000000000000000000000000000000007";

  it("writes the zero hash for a slot present in pre and omitted from post", () => {
    const overrides: Record<string, Record<string, unknown>> = {};
    // Accumulators often already hold the non-zero value from an earlier call
    // (e.g. approve wrote allowance, deposit then cleared it).
    overrides[TOKEN.toLowerCase()] = {
      stateDiff: { [SLOT]: NON_ZERO },
    };

    mergeDiffIntoOverridesForTests(
      overrides,
      {
        [TOKEN]: { storage: { [SLOT]: NON_ZERO } },
      },
      {
        // geth marks the account modified but omits the zeroed slot from post.
        [TOKEN]: { storage: {}, nonce: 4 },
      }
    );

    expect(overrides[TOKEN.toLowerCase()].stateDiff).toEqual({
      [SLOT]: ZERO,
    });
    expect(overrides[TOKEN.toLowerCase()].nonce).toBe("0x4");
  });

  it("still applies later non-zero writes after a clear", () => {
    const overrides: Record<string, Record<string, unknown>> = {};

    mergeDiffIntoOverridesForTests(
      overrides,
      {
        [TOKEN]: { storage: { [SLOT]: NON_ZERO } },
      },
      {
        [TOKEN]: { storage: {} },
      }
    );
    mergeDiffIntoOverridesForTests(
      overrides,
      {
        [TOKEN]: { storage: { [SLOT]: ZERO, [OTHER]: ZERO } },
      },
      {
        [TOKEN]: { storage: { [OTHER]: LATER } },
      }
    );

    expect(overrides[TOKEN.toLowerCase()].stateDiff).toEqual({
      [SLOT]: ZERO,
      [OTHER]: LATER,
    });
  });

  it("does not invent clears when pre has no storage for the account", () => {
    const overrides: Record<string, Record<string, unknown>> = {};

    mergeDiffIntoOverridesForTests(
      overrides,
      {},
      {
        [TOKEN]: { storage: { [SLOT]: NON_ZERO }, nonce: 3 },
      }
    );

    expect(overrides[TOKEN.toLowerCase()]).toEqual({
      stateDiff: { [SLOT]: NON_ZERO },
      nonce: "0x3",
    });
  });
});

describe("simulateCallSequence validation", () => {
  it("reaches no node when one call cannot be encoded", async () => {
    const result = await run([
      APPROVE_THEN_DEPOSIT[0],
      {
        contractAddress: VAULT,
        abi: VAULT_ABI,
        functionName: "withdraw",
        functionArgs: "[]",
      },
    ]);

    expect(spies.send).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.mechanism).toBeNull();
    expect(result.results[1]).toMatchObject({
      success: false,
      revertReason: "Function withdraw not found in ABI",
    });
    expect(result.results[0]).toMatchObject({
      success: false,
      failureKind: "unavailable",
    });
  });

  it("applies the stablecoin ceiling per call, as the broadcast does", async () => {
    spies.supportedTokensLookup.mockResolvedValue([
      {
        tokenAddress: TOKEN,
        decimals: 6,
        symbol: "USDC",
        isStablecoin: true,
      },
    ]);

    const result = await run([
      {
        contractAddress: TOKEN,
        abi: JSON.stringify([
          {
            type: "function",
            name: "transfer",
            stateMutability: "nonpayable",
            inputs: [
              { name: "to", type: "address" },
              { name: "amount", type: "uint256" },
            ],
            outputs: [{ name: "", type: "bool" }],
          },
        ]),
        functionName: "transfer",
        // 1,000,000 USDC, far over the 100 USD per-transaction ceiling.
        functionArgs: JSON.stringify([VAULT, "1000000000000"]),
      },
    ]);

    expect(spies.send).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toContain("USDC");
  });

  it("reads the chain's token list once for the whole sequence", async () => {
    spies.send.mockResolvedValueOnce([
      {
        calls: [
          { status: "0x1", gasUsed: "0x1", returnData: TRUE },
          { status: "0x1", gasUsed: "0x1", returnData: TRUE },
          { status: "0x1", gasUsed: "0x1", returnData: TRUE },
        ],
      },
    ]);

    await run([
      APPROVE_THEN_DEPOSIT[0],
      APPROVE_THEN_DEPOSIT[0],
      APPROVE_THEN_DEPOSIT[0],
    ]);

    expect(spies.supportedTokensLookup).toHaveBeenCalledTimes(1);
  });

  it("refuses an empty sequence and one that is too long", async () => {
    expect((await run([])).error).toContain("at least one call");
    const tooMany = Array.from({ length: 11 }, () => APPROVE_THEN_DEPOSIT[0]);
    expect((await run(tooMany)).error).toContain("at most 10");
  });
});
