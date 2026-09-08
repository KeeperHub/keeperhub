import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/db/schema", () => ({ explorerConfigs: {} }));
vi.mock("drizzle-orm", () => ({ eq: () => ({}) }));
vi.mock("@/lib/explorer", () => ({
  getAddressUrl: () => "",
  getTransactionUrl: () => "",
}));

const SIGNER_ADDRESS = "0x2c9F694183A4240B6431771F6c714a8106179dF5";
const SPENDER = "0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59";
const AMOUNT = BigInt(1000);

const mockStaticCall = vi.fn().mockResolvedValue(true);
const mockEstimateGas = vi.fn().mockResolvedValue(BigInt(50_000));
const mockSendTx = Object.assign(
  vi.fn().mockResolvedValue({
    hash: "0xtxhash",
    wait: vi.fn().mockResolvedValue({
      hash: "0xtxhash",
      gasUsed: BigInt(21_000),
      effectiveGasPrice: BigInt(1_000_000_000),
      blockNumber: 100,
    }),
  }),
  { staticCall: mockStaticCall, estimateGas: mockEstimateGas }
);

vi.mock("ethers", () => {
  function MockContract(): Record<string, unknown> {
    return {
      approve: mockSendTx,
      getFunction: (name: string): unknown => {
        if (name === "approve") {
          return mockSendTx;
        }
        throw new Error(`unknown function: ${name}`);
      },
    };
  }
  return {
    ethers: {
      Contract: MockContract,
    },
  };
});

import { EvmChainAdapter } from "@/lib/web3/chain-adapter/evm";

const APPROVE_ABI = [
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
];

function createMockSigner(): unknown {
  return {
    getAddress: vi.fn().mockResolvedValue(SIGNER_ADDRESS),
    provider: {
      getNetwork: vi.fn().mockResolvedValue({ chainId: BigInt(11_155_111) }),
    },
  };
}

function createAdapter(): EvmChainAdapter {
  const gasStrategy = {
    getGasConfig: vi.fn().mockResolvedValue({
      gasLimit: BigInt(100_000),
      maxFeePerGas: BigInt(1_000_000_000),
      maxPriorityFeePerGas: BigInt(1_000_000),
    }),
  };
  const nonceManager = { getNextNonce: vi.fn().mockReturnValue(5) };

  return new EvmChainAdapter(
    11_155_111,
    gasStrategy as any,
    nonceManager as any
  );
}

describe("EvmChainAdapter preflight signer address", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes signer address as from in staticCall and estimateGas", async () => {
    const adapter = createAdapter();
    const signer = createMockSigner();

    try {
      await adapter.executeContractCall(
        signer as any,
        {
          contractAddress: "0x779877A7B0D9E8603169DdbD7836e478b4624789",
          abi: APPROVE_ABI as unknown as import("ethers").InterfaceAbi,
          functionKey: "approve",
          args: [SPENDER, AMOUNT],
        },
        { currentNonce: 5 } as any,
        { gasOverrides: {} }
      );
    } catch (err) {
      // confirmTransaction fails with mocks - expected
      // But if staticCall wasn't called, re-throw to see the real error
      if (mockStaticCall.mock.calls.length === 0) {
        throw err;
      }
    }

    expect(mockStaticCall).toHaveBeenCalledTimes(1);
    const staticOverrides = mockStaticCall.mock.calls[0].at(-1);
    expect(staticOverrides.from).toBe(SIGNER_ADDRESS);

    expect(mockEstimateGas).toHaveBeenCalledTimes(1);
    const gasOverrides = mockEstimateGas.mock.calls[0].at(-1);
    expect(gasOverrides.from).toBe(SIGNER_ADDRESS);
  });

  it("includes value alongside from for payable calls", async () => {
    const adapter = createAdapter();
    const signer = createMockSigner();
    const ethValue = BigInt("1000000000000000000");

    try {
      await adapter.executeContractCall(
        signer as any,
        {
          contractAddress: "0x779877A7B0D9E8603169DdbD7836e478b4624789",
          abi: APPROVE_ABI as unknown as import("ethers").InterfaceAbi,
          functionKey: "approve",
          args: [SPENDER, AMOUNT],
          value: ethValue,
        },
        { currentNonce: 5 } as any,
        { gasOverrides: {} }
      );
    } catch {
      // confirmTransaction fails with mocks - expected
    }

    const staticOverrides = mockStaticCall.mock.calls[0].at(-1);
    expect(staticOverrides.from).toBe(SIGNER_ADDRESS);
    expect(staticOverrides.value).toBe(ethValue);

    const gasOverrides = mockEstimateGas.mock.calls[0].at(-1);
    expect(gasOverrides.from).toBe(SIGNER_ADDRESS);
    expect(gasOverrides.value).toBe(ethValue);
  });
});
