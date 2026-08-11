import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

// ── Mocks (before imports) ───────────────────────────────────────────

vi.mock("server-only", () => ({}));
vi.mock("@/protocols", () => ({}));

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

const mockReadContractCore = vi.fn();
vi.mock("@/plugins/web3/steps/read-contract-core", () => ({
  readContractCore: (...args: unknown[]) => mockReadContractCore(...args),
}));

// ── Import under test ────────────────────────────────────────────────

import { protocolReadStep } from "@/plugins/protocol/steps/protocol-read";
import type { ProtocolMeta } from "@/plugins/protocol/steps/resolve-protocol-meta";

// ── Fixtures ─────────────────────────────────────────────────────────

const COMPOUND_META: ProtocolMeta = {
  protocolSlug: "compound",
  contractKey: "comet",
  functionName: "getUtilization",
  actionType: "read",
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
      abi: '[{"name":"getUtilization","type":"function","inputs":[],"outputs":[{"type":"uint256"}]}]',
    },
  },
  actions: [
    {
      slug: "get-utilization",
      label: "Get Utilization",
      type: "read" as const,
      contract: "comet",
      function: "getUtilization",
      inputs: [],
      outputs: [{ name: "utilization", type: "uint256", label: "Utilization" }],
    },
  ],
};

const FIXED_ADDRESS_PROTOCOL = {
  name: "Fixed Protocol",
  slug: "fixed-proto",
  contracts: {
    pool: {
      label: "Pool",
      userSpecifiedAddress: false,
      addresses: {
        "1": "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      },
    },
  },
  actions: [
    {
      slug: "get-value",
      label: "Get Value",
      type: "read" as const,
      contract: "pool",
      function: "getValue",
      inputs: [],
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
  };
  [key: string]: unknown;
} {
  return {
    network: "8453",
    _actionType: "compound/get-utilization",
    contractAddress: "0xb125E6687d4313864e53df431d5425969c15Eb2F",
    _context: {
      executionId: "exec-123",
      nodeId: "action-1",
      nodeName: "Test Action",
      nodeType: "action",
    },
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

describe("protocolReadStep", () => {
  describe("withStepLogging wrapper", () => {
    it("calls withStepLogging for every execution path", async () => {
      mockResolveProtocolMeta.mockReturnValue(undefined);

      await protocolReadStep(makeInput());

      expect(mockWithStepLogging).toHaveBeenCalledTimes(1);
    });

    it("calls withStepLogging even when protocol meta resolution fails", async () => {
      mockResolveProtocolMeta.mockReturnValue(undefined);

      const result = await protocolReadStep(makeInput());

      expect(mockWithStepLogging).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("Invalid _protocolMeta");
      }
    });

    it("calls withStepLogging even when protocol lookup fails", async () => {
      mockResolveProtocolMeta.mockReturnValue(COMPOUND_META);
      mockGetProtocol.mockReturnValue(undefined);

      const result = await protocolReadStep(makeInput());

      expect(mockWithStepLogging).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(false);
    });

    it("calls withStepLogging even when ABI resolution throws", async () => {
      mockResolveProtocolMeta.mockReturnValue(COMPOUND_META);
      mockGetProtocol.mockReturnValue(COMPOUND_PROTOCOL);
      mockResolveAbi.mockRejectedValue(new Error("ABI fetch failed"));

      const result = await protocolReadStep(makeInput());

      expect(mockWithStepLogging).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(false);
    });

    it("propagates thrown errors from readContractCore through withStepLogging", async () => {
      mockResolveProtocolMeta.mockReturnValue(COMPOUND_META);
      mockGetProtocol.mockReturnValue(COMPOUND_PROTOCOL);
      mockResolveAbi.mockResolvedValue({ abi: "[]" });
      mockReadContractCore.mockRejectedValue(new Error("RPC timeout"));

      await expect(protocolReadStep(makeInput())).rejects.toThrow(
        "RPC timeout"
      );
      expect(mockWithStepLogging).toHaveBeenCalledTimes(1);
    });
  });

  describe("meta resolution failures", () => {
    it("returns error when _protocolMeta is invalid JSON and _actionType is missing", async () => {
      mockResolveProtocolMeta.mockReturnValue(undefined);

      const result = await protocolReadStep(
        makeInput({ _actionType: undefined, _protocolMeta: "not-json" })
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("Invalid _protocolMeta");
      }
    });

    it("returns error when both _protocolMeta and _actionType are missing", async () => {
      mockResolveProtocolMeta.mockReturnValue(undefined);

      const result = await protocolReadStep(
        makeInput({ _actionType: undefined, _protocolMeta: undefined })
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
        ...COMPOUND_META,
        protocolSlug: "nonexistent",
      });
      mockGetProtocol.mockReturnValue(undefined);

      const result = await protocolReadStep(makeInput());

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe("Unknown protocol: nonexistent");
      }
    });
  });

  describe("contract resolution failures", () => {
    it("returns error for unknown contract key", async () => {
      mockResolveProtocolMeta.mockReturnValue({
        ...COMPOUND_META,
        contractKey: "bogus-contract",
      });
      mockGetProtocol.mockReturnValue(COMPOUND_PROTOCOL);

      const result = await protocolReadStep(makeInput());

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Unknown contract key "bogus-contract"');
        expect(result.error).toContain("compound");
      }
    });

    it("returns error when userSpecifiedAddress is true but contractAddress is missing", async () => {
      mockResolveProtocolMeta.mockReturnValue(COMPOUND_META);
      mockGetProtocol.mockReturnValue(COMPOUND_PROTOCOL);

      const result = await protocolReadStep(
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
        contractKey: "pool",
        functionName: "getValue",
        actionType: "read",
      });
      mockGetProtocol.mockReturnValue(FIXED_ADDRESS_PROTOCOL);

      const result = await protocolReadStep(
        makeInput({ network: "42161" }) // Arbitrum -- not in addresses
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("is not deployed on network");
        expect(result.error).toContain("42161");
      }
    });
  });

  describe("ABI resolution failures", () => {
    it("returns error when resolveAbi throws an Error", async () => {
      mockResolveProtocolMeta.mockReturnValue(COMPOUND_META);
      mockGetProtocol.mockReturnValue(COMPOUND_PROTOCOL);
      mockResolveAbi.mockRejectedValue(new Error("Explorer API timeout"));

      const result = await protocolReadStep(makeInput());

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("Failed to resolve ABI");
        expect(result.error).toContain("Explorer API timeout");
      }
    });

    it("returns error when resolveAbi throws a non-Error value", async () => {
      mockResolveProtocolMeta.mockReturnValue(COMPOUND_META);
      mockGetProtocol.mockReturnValue(COMPOUND_PROTOCOL);
      mockResolveAbi.mockRejectedValue("string error");

      const result = await protocolReadStep(makeInput());

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("Failed to resolve ABI");
        expect(result.error).toContain("string error");
      }
    });
  });

  describe("successful delegation to readContractCore", () => {
    it("passes resolved inputs to readContractCore and returns success", async () => {
      mockResolveProtocolMeta.mockReturnValue(COMPOUND_META);
      mockGetProtocol.mockReturnValue(COMPOUND_PROTOCOL);
      mockResolveAbi.mockResolvedValue({
        abi: '[{"name":"getUtilization","type":"function"}]',
      });
      mockReadContractCore.mockResolvedValue({
        success: true,
        result: "850000000000000000",
        addressLink: "https://basescan.org/address/0xb125",
      });

      const result = await protocolReadStep(makeInput());

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toBe("850000000000000000");
      }

      expect(mockReadContractCore).toHaveBeenCalledWith({
        contractAddress: "0xb125E6687d4313864e53df431d5425969c15Eb2F",
        network: "8453",
        abi: '[{"name":"getUtilization","type":"function"}]',
        abiFunction: "getUtilization",
        functionArgs: undefined,
        _context: { executionId: "exec-123" },
      });
    });

    it("propagates readContractCore failure result", async () => {
      mockResolveProtocolMeta.mockReturnValue(COMPOUND_META);
      mockGetProtocol.mockReturnValue(COMPOUND_PROTOCOL);
      mockResolveAbi.mockResolvedValue({ abi: "[]" });
      mockReadContractCore.mockResolvedValue({
        success: false,
        error: "execution reverted",
      });

      const result = await protocolReadStep(makeInput());

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe("execution reverted");
      }
    });

    it("passes function arguments for actions with inputs", async () => {
      const metaWithInputs: ProtocolMeta = {
        protocolSlug: "compound",
        contractKey: "comet",
        functionName: "balanceOf",
        actionType: "read",
      };

      const protocolWithInputs = {
        ...COMPOUND_PROTOCOL,
        actions: [
          {
            slug: "get-balance",
            label: "Get Balance",
            type: "read" as const,
            contract: "comet",
            function: "balanceOf",
            inputs: [{ name: "account", type: "address", label: "Account" }],
          },
        ],
      };

      mockResolveProtocolMeta.mockReturnValue(metaWithInputs);
      mockGetProtocol.mockReturnValue(protocolWithInputs);
      mockResolveAbi.mockResolvedValue({ abi: "[]" });
      mockReadContractCore.mockResolvedValue({
        success: true,
        result: "1000000",
        addressLink: "https://basescan.org/address/0xb125",
      });

      const result = await protocolReadStep(
        makeInput({ account: "0xDeaDbeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF" })
      );

      expect(result.success).toBe(true);

      const coreCall = (mockReadContractCore as Mock).mock.calls[0][0];
      const parsedArgs = JSON.parse(coreCall.functionArgs);
      expect(parsedArgs).toEqual([
        "0xDeaDbeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF",
      ]);
    });

    it("omits _context when input has no _context", async () => {
      mockResolveProtocolMeta.mockReturnValue(COMPOUND_META);
      mockGetProtocol.mockReturnValue(COMPOUND_PROTOCOL);
      mockResolveAbi.mockResolvedValue({ abi: "[]" });
      mockReadContractCore.mockResolvedValue({
        success: true,
        result: "0",
        addressLink: "",
      });

      await protocolReadStep(makeInput({ _context: undefined }));

      const coreCall = (mockReadContractCore as Mock).mock.calls[0][0];
      expect(coreCall._context).toBeUndefined();
    });
  });

  describe("Compound V3 specific scenarios", () => {
    it("handles Compound get-utilization on Base (the original failing case)", async () => {
      mockResolveProtocolMeta.mockReturnValue(COMPOUND_META);
      mockGetProtocol.mockReturnValue(COMPOUND_PROTOCOL);
      mockResolveAbi.mockResolvedValue({
        abi: COMPOUND_PROTOCOL.contracts.comet.abi,
      });
      mockReadContractCore.mockResolvedValue({
        success: true,
        result: "850000000000000000",
        addressLink:
          "https://basescan.org/address/0xb125E6687d4313864e53df431d5425969c15Eb2F",
      });

      const result = await protocolReadStep(
        makeInput({
          network: "8453",
          contractAddress: "0xb125E6687d4313864e53df431d5425969c15Eb2F",
          _actionType: "compound/get-utilization",
        })
      );

      expect(mockWithStepLogging).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(true);
    });

    it("handles Compound on Ethereum mainnet", async () => {
      mockResolveProtocolMeta.mockReturnValue(COMPOUND_META);
      mockGetProtocol.mockReturnValue(COMPOUND_PROTOCOL);
      mockResolveAbi.mockResolvedValue({
        abi: COMPOUND_PROTOCOL.contracts.comet.abi,
      });
      mockReadContractCore.mockResolvedValue({
        success: true,
        result: "700000000000000000",
        addressLink:
          "https://etherscan.io/address/0xc3d688B66703497DAA19211EEdff47f25384cdc3",
      });

      const result = await protocolReadStep(
        makeInput({
          network: "1",
          contractAddress: "0xc3d688B66703497DAA19211EEdff47f25384cdc3",
        })
      );

      expect(result.success).toBe(true);
    });

    it("fails with logged error when Compound comet address is missing for Base", async () => {
      mockResolveProtocolMeta.mockReturnValue(COMPOUND_META);
      mockGetProtocol.mockReturnValue(COMPOUND_PROTOCOL);

      const result = await protocolReadStep(
        makeInput({
          network: "8453",
          contractAddress: undefined,
        })
      );

      expect(mockWithStepLogging).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("Missing contract address");
      }
    });
  });
});
