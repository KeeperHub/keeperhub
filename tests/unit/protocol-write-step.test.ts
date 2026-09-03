import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

// ── Mocks (before imports) ───────────────────────────────────────────

vi.mock("server-only", () => ({}));
vi.mock("@/protocols", () => ({}));

const mockLogUserError = vi.fn();
vi.mock("@/lib/logging", () => ({
  ErrorCategory: { CONFIGURATION: "configuration" },
  logUserError: (...args: unknown[]) => mockLogUserError(...args),
}));

const mockWithStepLogging = vi.fn((_input: unknown, fn: () => unknown) => fn());

vi.mock("@/lib/workflow/executor/step-handler", () => ({
  withStepLogging: (...args: unknown[]) =>
    mockWithStepLogging(...(args as [unknown, () => unknown])),
}));

const mockResolveProtocolMeta = vi.fn();
vi.mock("@/plugins/protocol/steps/resolve-protocol-meta", () => ({
  resolveProtocolMeta: (...args: unknown[]) => mockResolveProtocolMeta(...args),
}));

const mockGetProtocol = vi.fn();
vi.mock("@/lib/protocol-registry", () => ({
  getProtocol: (...args: unknown[]) => mockGetProtocol(...args),
  resolveContractAddress: (
    contract: {
      userSpecifiedAddress?: boolean;
      addresses: Record<string, string>;
    },
    network: string,
    providedAddress: string | undefined
  ) =>
    contract.userSpecifiedAddress
      ? providedAddress
      : contract.addresses[network],
}));

const mockResolveAbi = vi.fn();
vi.mock("@/lib/abi/cache", () => ({
  resolveAbi: (...args: unknown[]) => mockResolveAbi(...args),
}));

const mockWriteContractCore = vi.fn();
vi.mock("@/plugins/web3/steps/write-contract-core", () => ({
  writeContractCore: (...args: unknown[]) => mockWriteContractCore(...args),
}));

// ── Import under test ────────────────────────────────────────────────

import { protocolWriteStep } from "@/plugins/protocol/steps/protocol-write";
import type { ProtocolMeta } from "@/plugins/protocol/steps/resolve-protocol-meta";

// ── Fixtures ─────────────────────────────────────────────────────────

const COMPOUND_SUPPLY_META: ProtocolMeta = {
  protocolSlug: "compound",
  contractKey: "comet",
  functionName: "supply",
  actionType: "write",
};

const COMPOUND_PROTOCOL = {
  name: "Compound V3",
  slug: "compound",
  contracts: {
    comet: {
      label: "Comet Market",
      userSpecifiedAddress: true,
      addresses: {
        "1": "0xc3d688B66703497DAA19211EEdff47f25384cdc3",
        "8453": "0xb125E6687d4313864e53df431d5425969c15Eb2F",
      },
      abi: '[{"name":"supply","type":"function","inputs":[{"name":"asset","type":"address"},{"name":"amount","type":"uint256"}],"outputs":[]}]',
    },
  },
  actions: [
    {
      slug: "supply",
      label: "Supply Asset",
      type: "write" as const,
      contract: "comet",
      function: "supply",
      inputs: [
        { name: "asset", type: "address", label: "Asset Address" },
        { name: "amount", type: "uint256", label: "Amount" },
      ],
    },
  ],
};

const FIXED_ADDRESS_PROTOCOL = {
  name: "Fixed Protocol",
  slug: "fixed-proto",
  contracts: {
    vault: {
      label: "Vault",
      userSpecifiedAddress: false,
      addresses: {
        "1": "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      },
    },
  },
  actions: [
    {
      slug: "deposit",
      label: "Deposit",
      type: "write" as const,
      contract: "vault",
      function: "deposit",
      inputs: [{ name: "amount", type: "uint256", label: "Amount" }],
    },
  ],
};

function makeInput(overrides: Record<string, unknown> = {}): {
  network: string;
  _actionType: string;
  _context: {
    executionId: string;
    nodeId: string;
    nodeName: string;
    nodeType: string;
    triggerType: string;
  };
  [key: string]: unknown;
} {
  return {
    network: "8453",
    _actionType: "compound/supply",
    contractAddress: "0xb125E6687d4313864e53df431d5425969c15Eb2F",
    asset: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    amount: "1000000",
    _context: {
      executionId: "exec-456",
      nodeId: "action-1",
      nodeName: "Test Action",
      nodeType: "action",
      triggerType: "manual",
    },
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

describe("protocolWriteStep", () => {
  describe("withStepLogging wrapper", () => {
    it("calls withStepLogging for every execution path", async () => {
      mockResolveProtocolMeta.mockReturnValue(undefined);

      await protocolWriteStep(makeInput());

      expect(mockWithStepLogging).toHaveBeenCalledTimes(1);
    });

    it("calls withStepLogging even when protocol meta resolution fails", async () => {
      mockResolveProtocolMeta.mockReturnValue(undefined);

      const result = await protocolWriteStep(makeInput());

      expect(mockWithStepLogging).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("Invalid _protocolMeta");
      }
    });

    it("calls withStepLogging even when protocol lookup fails", async () => {
      mockResolveProtocolMeta.mockReturnValue(COMPOUND_SUPPLY_META);
      mockGetProtocol.mockReturnValue(undefined);

      const result = await protocolWriteStep(makeInput());

      expect(mockWithStepLogging).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(false);
    });

    it("calls withStepLogging even when ABI resolution throws", async () => {
      mockResolveProtocolMeta.mockReturnValue(COMPOUND_SUPPLY_META);
      mockGetProtocol.mockReturnValue(COMPOUND_PROTOCOL);
      mockResolveAbi.mockRejectedValue(new Error("ABI fetch failed"));

      const result = await protocolWriteStep(makeInput());

      expect(mockWithStepLogging).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(false);
    });

    it("propagates thrown errors from writeContractCore through withStepLogging", async () => {
      mockResolveProtocolMeta.mockReturnValue(COMPOUND_SUPPLY_META);
      mockGetProtocol.mockReturnValue(COMPOUND_PROTOCOL);
      mockResolveAbi.mockResolvedValue({ abi: "[]" });
      mockWriteContractCore.mockRejectedValue(new Error("RPC timeout"));

      await expect(protocolWriteStep(makeInput())).rejects.toThrow(
        "RPC timeout"
      );
      expect(mockWithStepLogging).toHaveBeenCalledTimes(1);
    });
  });

  describe("meta resolution failures", () => {
    it("returns error when both _protocolMeta and _actionType are invalid", async () => {
      mockResolveProtocolMeta.mockReturnValue(undefined);

      const result = await protocolWriteStep(
        makeInput({ _actionType: undefined, _protocolMeta: "bad-json" })
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("Invalid _protocolMeta");
      }
    });
  });

  describe("protocol lookup failures", () => {
    it("returns error for unknown protocol slug", async () => {
      mockResolveProtocolMeta.mockReturnValue({
        ...COMPOUND_SUPPLY_META,
        protocolSlug: "nonexistent",
      });
      mockGetProtocol.mockReturnValue(undefined);

      const result = await protocolWriteStep(makeInput());

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe("Unknown protocol: nonexistent");
      }
    });
  });

  describe("contract resolution failures", () => {
    it("returns error for unknown contract key", async () => {
      mockResolveProtocolMeta.mockReturnValue({
        ...COMPOUND_SUPPLY_META,
        contractKey: "bogus",
      });
      mockGetProtocol.mockReturnValue(COMPOUND_PROTOCOL);

      const result = await protocolWriteStep(makeInput());

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Unknown contract key "bogus"');
      }
    });

    it("returns error when userSpecifiedAddress is true but contractAddress is missing", async () => {
      mockResolveProtocolMeta.mockReturnValue(COMPOUND_SUPPLY_META);
      mockGetProtocol.mockReturnValue(COMPOUND_PROTOCOL);

      const result = await protocolWriteStep(
        makeInput({ contractAddress: undefined })
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("Missing contract address");
      }
    });

    it("returns error when fixed-address contract is not deployed on the requested network", async () => {
      mockResolveProtocolMeta.mockReturnValue({
        protocolSlug: "fixed-proto",
        contractKey: "vault",
        functionName: "deposit",
        actionType: "write",
      });
      mockGetProtocol.mockReturnValue(FIXED_ADDRESS_PROTOCOL);

      const result = await protocolWriteStep(makeInput({ network: "42161" }));

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("is not deployed on network");
        expect(result.error).toContain("42161");
      }
    });
  });

  describe("ABI resolution failures", () => {
    it("returns error when resolveAbi throws an Error", async () => {
      mockResolveProtocolMeta.mockReturnValue(COMPOUND_SUPPLY_META);
      mockGetProtocol.mockReturnValue(COMPOUND_PROTOCOL);
      mockResolveAbi.mockRejectedValue(new Error("Explorer API timeout"));

      const result = await protocolWriteStep(makeInput());

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("Failed to resolve ABI");
        expect(result.error).toContain("Explorer API timeout");
      }
    });

    it("returns error when resolveAbi throws a non-Error value", async () => {
      mockResolveProtocolMeta.mockReturnValue(COMPOUND_SUPPLY_META);
      mockGetProtocol.mockReturnValue(COMPOUND_PROTOCOL);
      mockResolveAbi.mockRejectedValue("raw string error");

      const result = await protocolWriteStep(makeInput());

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("raw string error");
      }
    });
  });

  describe("successful delegation to writeContractCore", () => {
    it("passes resolved inputs to writeContractCore and returns success", async () => {
      mockResolveProtocolMeta.mockReturnValue(COMPOUND_SUPPLY_META);
      mockGetProtocol.mockReturnValue(COMPOUND_PROTOCOL);
      mockResolveAbi.mockResolvedValue({
        abi: COMPOUND_PROTOCOL.contracts.comet.abi,
      });
      mockWriteContractCore.mockResolvedValue({
        success: true,
        transactionHash: "0xabc123",
        transactionLink: "https://basescan.org/tx/0xabc123",
        gasUsed: "150000",
      });

      const result = await protocolWriteStep(makeInput());

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.transactionHash).toBe("0xabc123");
      }

      expect(mockWriteContractCore).toHaveBeenCalledWith({
        contractAddress: "0xb125E6687d4313864e53df431d5425969c15Eb2F",
        network: "8453",
        abi: COMPOUND_PROTOCOL.contracts.comet.abi,
        abiFunction: "supply",
        functionArgs: JSON.stringify([
          "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          "1000000",
        ]),
        ethValue: undefined,
        _context: { executionId: "exec-456" },
      });
    });

    it("propagates writeContractCore failure result", async () => {
      mockResolveProtocolMeta.mockReturnValue(COMPOUND_SUPPLY_META);
      mockGetProtocol.mockReturnValue(COMPOUND_PROTOCOL);
      mockResolveAbi.mockResolvedValue({ abi: "[]" });
      mockWriteContractCore.mockResolvedValue({
        success: false,
        error: "insufficient funds",
      });

      const result = await protocolWriteStep(makeInput());

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe("insufficient funds");
      }
    });

    it("passes ethValue when provided", async () => {
      mockResolveProtocolMeta.mockReturnValue(COMPOUND_SUPPLY_META);
      mockGetProtocol.mockReturnValue(COMPOUND_PROTOCOL);
      mockResolveAbi.mockResolvedValue({ abi: "[]" });
      mockWriteContractCore.mockResolvedValue({
        success: true,
        transactionHash: "0xdef",
        transactionLink: "",
        gasUsed: "21000",
      });

      await protocolWriteStep(makeInput({ ethValue: "0.5" }));

      const coreCall = (mockWriteContractCore as Mock).mock.calls[0][0];
      expect(coreCall.ethValue).toBe("0.5");
    });

    it("ignores empty/whitespace ethValue", async () => {
      mockResolveProtocolMeta.mockReturnValue(COMPOUND_SUPPLY_META);
      mockGetProtocol.mockReturnValue(COMPOUND_PROTOCOL);
      mockResolveAbi.mockResolvedValue({ abi: "[]" });
      mockWriteContractCore.mockResolvedValue({
        success: true,
        transactionHash: "0xdef",
        transactionLink: "",
        gasUsed: "21000",
      });

      await protocolWriteStep(makeInput({ ethValue: "  " }));

      const coreCall = (mockWriteContractCore as Mock).mock.calls[0][0];
      expect(coreCall.ethValue).toBeUndefined();
    });

    // KEEP-393: form state can carry a stale ethValue from a previous action
    // configuration (e.g. WETH.deposit) into a non-payable action (e.g. a
    // Uniswap swap). Drop the value rather than let writeContractCore surface
    // the opaque "function is not payable" error.
    describe("KEEP-393 stale ethValue guard", () => {
      const PAYABLE_ABI = JSON.stringify([
        {
          type: "function",
          name: "deposit",
          stateMutability: "payable",
          inputs: [],
          outputs: [],
        },
      ]);

      // Uses compound.supply (nonpayable upstream) rather than a Uniswap swap:
      // post-KEEP-408 the Uniswap swap functions are correctly typed as
      // payable, so resolveEthValue would no longer drop the value there
      // (and the KEEP-408 preflight would reject the stale ethValue with a
      // user-facing error before this guard runs). The KEEP-393 mechanism
      // still matters for any payable -> nonpayable action reconfiguration,
      // which compound.supply demonstrates.
      it("drops ethValue when the resolved function is nonpayable and logs the drop", async () => {
        const COMPOUND_SUPPLY_NONPAYABLE_ABI = JSON.stringify([
          {
            type: "function",
            name: "supply",
            stateMutability: "nonpayable",
            inputs: [],
            outputs: [],
          },
        ]);
        mockResolveProtocolMeta.mockReturnValue(COMPOUND_SUPPLY_META);
        mockGetProtocol.mockReturnValue(COMPOUND_PROTOCOL);
        mockResolveAbi.mockResolvedValue({
          abi: COMPOUND_SUPPLY_NONPAYABLE_ABI,
        });
        mockWriteContractCore.mockResolvedValue({
          success: true,
          transactionHash: "0xsupply",
          transactionLink: "",
          gasUsed: "150000",
        });

        await protocolWriteStep(
          makeInput({
            network: "8453",
            ethValue: "0.04",
            _actionType: "compound/supply",
          })
        );

        const coreCall = (mockWriteContractCore as Mock).mock.calls[0][0];
        expect(coreCall.ethValue).toBeUndefined();

        expect(mockLogUserError).toHaveBeenCalledTimes(1);
        const [category, message, , labels] = (mockLogUserError as Mock).mock
          .calls[0];
        expect(category).toBe("configuration");
        expect(message).toContain("Dropped ethValue");
        expect(message).toContain("supply");
        expect(message).toContain("0.04");
        expect(labels).toMatchObject({
          plugin_name: "protocol",
          action_name: "protocol-write",
          protocol_slug: "compound",
          function_name: "supply",
          state_mutability: "nonpayable",
        });
      });

      it("preserves ethValue when the resolved function is payable", async () => {
        mockResolveProtocolMeta.mockReturnValue({
          protocolSlug: "wrapped",
          contractKey: "weth",
          functionName: "deposit",
          actionType: "write",
        });
        mockGetProtocol.mockReturnValue({
          name: "WETH",
          slug: "wrapped",
          contracts: {
            weth: {
              label: "WETH",
              userSpecifiedAddress: false,
              addresses: {
                "11155111": "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14",
              },
            },
          },
          actions: [],
        });
        mockResolveAbi.mockResolvedValue({ abi: PAYABLE_ABI });
        mockWriteContractCore.mockResolvedValue({
          success: true,
          transactionHash: "0xdep",
          transactionLink: "",
          gasUsed: "50000",
        });

        await protocolWriteStep(
          makeInput({
            network: "11155111",
            ethValue: "0.04",
            _actionType: "wrapped/deposit",
          })
        );

        const coreCall = (mockWriteContractCore as Mock).mock.calls[0][0];
        expect(coreCall.ethValue).toBe("0.04");
      });

      it("passes ethValue through when the function is missing from the ABI", async () => {
        // ABI does not contain the resolved function name. Pass through and
        // let writeContractCore produce its existing "function not found" error
        // instead of silently mutating user input.
        mockResolveProtocolMeta.mockReturnValue(COMPOUND_SUPPLY_META);
        mockGetProtocol.mockReturnValue(COMPOUND_PROTOCOL);
        mockResolveAbi.mockResolvedValue({ abi: "[]" });
        mockWriteContractCore.mockResolvedValue({
          success: true,
          transactionHash: "0x000",
          transactionLink: "",
          gasUsed: "21000",
        });

        await protocolWriteStep(makeInput({ ethValue: "1.5" }));

        const coreCall = (mockWriteContractCore as Mock).mock.calls[0][0];
        expect(coreCall.ethValue).toBe("1.5");
      });

      it("passes ethValue through when the ABI fails to parse", async () => {
        mockResolveProtocolMeta.mockReturnValue(COMPOUND_SUPPLY_META);
        mockGetProtocol.mockReturnValue(COMPOUND_PROTOCOL);
        mockResolveAbi.mockResolvedValue({ abi: "not-json" });
        mockWriteContractCore.mockResolvedValue({
          success: true,
          transactionHash: "0x000",
          transactionLink: "",
          gasUsed: "21000",
        });

        await protocolWriteStep(makeInput({ ethValue: "0.25" }));

        const coreCall = (mockWriteContractCore as Mock).mock.calls[0][0];
        expect(coreCall.ethValue).toBe("0.25");
      });

      it("passes ethValue through when the ABI is valid JSON but not an array", async () => {
        // Some auto-fetched ABIs come back wrapped (e.g. `{"abi": [...]}`).
        // We only know how to inspect array-form ABIs; fall back to passing
        // the value through and let writeContractCore handle it.
        mockResolveProtocolMeta.mockReturnValue(COMPOUND_SUPPLY_META);
        mockGetProtocol.mockReturnValue(COMPOUND_PROTOCOL);
        mockResolveAbi.mockResolvedValue({
          abi: '{"type":"function","name":"supply"}',
        });
        mockWriteContractCore.mockResolvedValue({
          success: true,
          transactionHash: "0x000",
          transactionLink: "",
          gasUsed: "21000",
        });

        await protocolWriteStep(makeInput({ ethValue: "0.5" }));

        const coreCall = (mockWriteContractCore as Mock).mock.calls[0][0];
        expect(coreCall.ethValue).toBe("0.5");
        expect(mockLogUserError).not.toHaveBeenCalled();
      });

      it("preserves ethValue when the function has no stateMutability field", async () => {
        // Pre-Solidity 0.5 ABIs may omit stateMutability. Without explicit
        // information we cannot know whether the function is payable, so
        // err on the side of preserving user input.
        mockResolveProtocolMeta.mockReturnValue(COMPOUND_SUPPLY_META);
        mockGetProtocol.mockReturnValue(COMPOUND_PROTOCOL);
        mockResolveAbi.mockResolvedValue({
          abi: JSON.stringify([
            { type: "function", name: "supply", inputs: [], outputs: [] },
          ]),
        });
        mockWriteContractCore.mockResolvedValue({
          success: true,
          transactionHash: "0x000",
          transactionLink: "",
          gasUsed: "21000",
        });

        await protocolWriteStep(makeInput({ ethValue: "0.75" }));

        const coreCall = (mockWriteContractCore as Mock).mock.calls[0][0];
        expect(coreCall.ethValue).toBe("0.75");
        expect(mockLogUserError).not.toHaveBeenCalled();
      });

      it.each([
        ["view", "view"],
        ["pure", "pure"],
      ])("drops ethValue when the resolved function is %s", async (_label, mutability) => {
        mockResolveProtocolMeta.mockReturnValue(COMPOUND_SUPPLY_META);
        mockGetProtocol.mockReturnValue(COMPOUND_PROTOCOL);
        mockResolveAbi.mockResolvedValue({
          abi: JSON.stringify([
            {
              type: "function",
              name: "supply",
              stateMutability: mutability,
              inputs: [],
              outputs: [],
            },
          ]),
        });
        mockWriteContractCore.mockResolvedValue({
          success: true,
          transactionHash: "0x000",
          transactionLink: "",
          gasUsed: "21000",
        });

        await protocolWriteStep(makeInput({ ethValue: "0.1" }));

        const coreCall = (mockWriteContractCore as Mock).mock.calls[0][0];
        expect(coreCall.ethValue).toBeUndefined();
        expect(mockLogUserError).toHaveBeenCalledTimes(1);
        const labels = (mockLogUserError as Mock).mock.calls[0][3];
        expect(labels.state_mutability).toBe(mutability);
      });
    });

    it("omits _context when input has no _context", async () => {
      mockResolveProtocolMeta.mockReturnValue(COMPOUND_SUPPLY_META);
      mockGetProtocol.mockReturnValue(COMPOUND_PROTOCOL);
      mockResolveAbi.mockResolvedValue({ abi: "[]" });
      mockWriteContractCore.mockResolvedValue({
        success: true,
        transactionHash: "0x111",
        transactionLink: "",
        gasUsed: "21000",
      });

      await protocolWriteStep(makeInput({ _context: undefined }));

      const coreCall = (mockWriteContractCore as Mock).mock.calls[0][0];
      expect(coreCall._context).toBeUndefined();
    });
  });

  // KEEP-408: Uniswap swap functions are payable upstream so SwapRouter02 can
  // wrap msg.value when tokenIn is the chain's WETH. Sending ETH with any
  // other tokenIn strands the ETH in the router. Preflight enforces this
  // before the tx is sent.
  describe("KEEP-408 Uniswap native-ETH preflight", () => {
    const WETH_SEPOLIA = "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14";

    const PAYABLE_SWAP_ABI = JSON.stringify([
      {
        type: "function",
        name: "exactInputSingle",
        stateMutability: "payable",
        inputs: [],
        outputs: [],
      },
    ]);

    const UNISWAP_PROTOCOL = {
      name: "Uniswap V3",
      slug: "uniswap",
      contracts: {
        swapRouter: {
          label: "SwapRouter02",
          userSpecifiedAddress: false,
          addresses: {
            "11155111": "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E",
          },
        },
      },
      actions: [],
    };

    const WRAPPED_PROTOCOL = {
      name: "Wrapped",
      slug: "wrapped",
      contracts: {
        weth: {
          label: "WETH",
          userSpecifiedAddress: false,
          addresses: {
            "11155111": WETH_SEPOLIA,
          },
        },
      },
      actions: [],
    };

    function setupUniswapSwap(): void {
      mockResolveProtocolMeta.mockReturnValue({
        protocolSlug: "uniswap",
        contractKey: "swapRouter",
        functionName: "exactInputSingle",
        actionType: "write",
      });
      mockGetProtocol.mockImplementation((slug: string) => {
        if (slug === "uniswap") {
          return UNISWAP_PROTOCOL;
        }
        if (slug === "wrapped") {
          return WRAPPED_PROTOCOL;
        }
        return undefined;
      });
      mockResolveAbi.mockResolvedValue({ abi: PAYABLE_SWAP_ABI });
      mockWriteContractCore.mockResolvedValue({
        success: true,
        transactionHash: "0xswap",
        transactionLink: "",
        gasUsed: "150000",
      });
    }

    it("rejects when ethValue is set but tokenIn is not WETH", async () => {
      setupUniswapSwap();

      const result = await protocolWriteStep(
        makeInput({
          network: "11155111",
          ethValue: "0.1",
          tokenIn: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          _actionType: "uniswap/swap-exact-input",
        })
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("Input Token");
        expect(result.error).toContain(WETH_SEPOLIA);
        expect(result.error).toContain("stranded");
      }
      expect(mockWriteContractCore).not.toHaveBeenCalled();
    });

    it("allows native ETH swap when tokenIn matches the chain WETH", async () => {
      setupUniswapSwap();

      const result = await protocolWriteStep(
        makeInput({
          network: "11155111",
          ethValue: "0.1",
          tokenIn: WETH_SEPOLIA,
          _actionType: "uniswap/swap-exact-input",
        })
      );

      expect(result.success).toBe(true);
      expect(mockWriteContractCore).toHaveBeenCalledTimes(1);
      const coreCall = (mockWriteContractCore as Mock).mock.calls[0][0];
      expect(coreCall.ethValue).toBe("0.1");
    });

    it("allows native ETH swap when tokenIn matches WETH with different case", async () => {
      setupUniswapSwap();

      const result = await protocolWriteStep(
        makeInput({
          network: "11155111",
          ethValue: "0.1",
          tokenIn: WETH_SEPOLIA.toLowerCase(),
          _actionType: "uniswap/swap-exact-input",
        })
      );

      expect(result.success).toBe(true);
      expect(mockWriteContractCore).toHaveBeenCalledTimes(1);
    });

    it("allows ERC20-to-ERC20 swap (no ethValue) regardless of tokenIn", async () => {
      setupUniswapSwap();

      const result = await protocolWriteStep(
        makeInput({
          network: "11155111",
          tokenIn: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          _actionType: "uniswap/swap-exact-input",
        })
      );

      expect(result.success).toBe(true);
      expect(mockWriteContractCore).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["empty string", ""],
      ["whitespace only", "   "],
      ["zero", "0"],
      ["zero with decimals", "0.0"],
      ["zero with many decimals", "0.0000"],
      // Forms a regex would false-positive but parseEther correctly sees as zero:
      ["leading-zero zero", "00"],
      ["leading dot zero", ".0"],
    ])("treats ethValue %s as no native value and skips the WETH check", async (_label, ethValue) => {
      setupUniswapSwap();

      const result = await protocolWriteStep(
        makeInput({
          network: "11155111",
          ethValue,
          tokenIn: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          _actionType: "uniswap/swap-exact-input",
        })
      );

      expect(result.success).toBe(true);
      expect(mockWriteContractCore).toHaveBeenCalledTimes(1);
    });

    it("rejects when ethValue is set but tokenIn is missing", async () => {
      setupUniswapSwap();

      const result = await protocolWriteStep(
        makeInput({
          network: "11155111",
          ethValue: "0.1",
          tokenIn: undefined,
          _actionType: "uniswap/swap-exact-input",
        })
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("Input Token Address is missing");
      }
      expect(mockWriteContractCore).not.toHaveBeenCalled();
    });

    it("rejects when WETH address for chain is not registered", async () => {
      mockResolveProtocolMeta.mockReturnValue({
        protocolSlug: "uniswap",
        contractKey: "swapRouter",
        functionName: "exactInputSingle",
        actionType: "write",
      });
      mockGetProtocol.mockImplementation((slug: string) => {
        if (slug === "uniswap") {
          return UNISWAP_PROTOCOL;
        }
        return undefined;
      });
      mockResolveAbi.mockResolvedValue({ abi: PAYABLE_SWAP_ABI });

      const result = await protocolWriteStep(
        makeInput({
          network: "11155111",
          ethValue: "0.1",
          tokenIn: WETH_SEPOLIA,
          _actionType: "uniswap/swap-exact-input",
        })
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("WETH address for chain");
      }
      expect(mockWriteContractCore).not.toHaveBeenCalled();
    });

    it("does not interfere with non-Uniswap payable functions (e.g. WETH.deposit)", async () => {
      mockResolveProtocolMeta.mockReturnValue({
        protocolSlug: "wrapped",
        contractKey: "weth",
        functionName: "deposit",
        actionType: "write",
      });
      mockGetProtocol.mockReturnValue(WRAPPED_PROTOCOL);
      mockResolveAbi.mockResolvedValue({
        abi: JSON.stringify([
          {
            type: "function",
            name: "deposit",
            stateMutability: "payable",
            inputs: [],
            outputs: [],
          },
        ]),
      });
      mockWriteContractCore.mockResolvedValue({
        success: true,
        transactionHash: "0xdep",
        transactionLink: "",
        gasUsed: "50000",
      });

      const result = await protocolWriteStep(
        makeInput({
          network: "11155111",
          ethValue: "0.5",
          _actionType: "wrapped/deposit",
        })
      );

      expect(result.success).toBe(true);
    });
  });

  describe("Compound V3 specific scenarios", () => {
    it("handles Compound supply on Base", async () => {
      mockResolveProtocolMeta.mockReturnValue(COMPOUND_SUPPLY_META);
      mockGetProtocol.mockReturnValue(COMPOUND_PROTOCOL);
      mockResolveAbi.mockResolvedValue({
        abi: COMPOUND_PROTOCOL.contracts.comet.abi,
      });
      mockWriteContractCore.mockResolvedValue({
        success: true,
        transactionHash: "0xbase-tx",
        transactionLink: "https://basescan.org/tx/0xbase-tx",
        gasUsed: "200000",
      });

      const result = await protocolWriteStep(makeInput());

      expect(mockWithStepLogging).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(true);
    });

    it("fails with logged error when Compound comet address is missing", async () => {
      mockResolveProtocolMeta.mockReturnValue(COMPOUND_SUPPLY_META);
      mockGetProtocol.mockReturnValue(COMPOUND_PROTOCOL);

      const result = await protocolWriteStep(
        makeInput({ contractAddress: undefined })
      );

      expect(mockWithStepLogging).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("Missing contract address");
      }
    });
  });
});
