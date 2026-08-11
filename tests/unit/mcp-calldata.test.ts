import { beforeEach, describe, expect, it, vi } from "vitest";

// -- hoisted mocks --
const { mockEncodeFunctionData, mockParseEther } = vi.hoisted(() => {
  const encodeFunctionData = vi.fn();
  const parseEther = vi.fn();
  return {
    mockEncodeFunctionData: encodeFunctionData,
    mockParseEther: parseEther,
  };
});

vi.mock("ethers", () => {
  // Use a named function so it works as a `new` constructor
  function MockInterface(this: {
    encodeFunctionData: typeof mockEncodeFunctionData;
  }) {
    this.encodeFunctionData = mockEncodeFunctionData;
  }
  return {
    ethers: {
      Interface: MockInterface,
      parseEther: mockParseEther,
    },
  };
});

import { generateCalldataForWorkflow } from "@/lib/mcp/calldata";

const SAMPLE_ABI = JSON.stringify([
  {
    name: "transfer",
    type: "function",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
]);

function makeWriteNode(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: "write-1",
    data: {
      actionType: "web3/write-contract",
      config: {
        contractAddress: "0xContractAddress",
        network: "base",
        abi: SAMPLE_ABI,
        abiFunction: "transfer",
        functionArgs: JSON.stringify(["0xRecipient", "1000"]),
        ethValue: "",
        ...overrides,
      },
    },
  };
}

// Canonical post-sanitize shape: actionType lives at data.config.actionType.
// Mirrors what lib/workflow/editor/sanitize-nodes.ts produces and what the DB
// actually stores for a saved workflow.
function makeCanonicalWriteNode(
  overrides: Record<string, unknown> = {}
): unknown {
  return {
    id: "write-1",
    type: "action",
    data: {
      type: "action",
      label: "Write transfer",
      status: "idle",
      config: {
        actionType: "web3/write-contract",
        contractAddress: "0xContractAddress",
        network: "base",
        abi: SAMPLE_ABI,
        abiFunction: "transfer",
        functionArgs: JSON.stringify(["0xRecipient", "1000"]),
        ethValue: "",
        ...overrides,
      },
    },
  };
}

describe("generateCalldataForWorkflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEncodeFunctionData.mockReturnValue("0xencodeddata");
    mockParseEther.mockReturnValue(BigInt("100000000000000000")); // 0.1 ETH in wei
  });

  it("returns success with to, data, value for a valid write-contract node", () => {
    const nodes = [makeWriteNode()];
    const result = generateCalldataForWorkflow(nodes, {});

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.to).toBe("0xContractAddress");
      expect(result.data).toBe("0xencodeddata");
      expect(result.value).toBe("0");
    }
  });

  it("matches the canonical post-sanitize shape (data.config.actionType)", () => {
    // This is the shape the canvas actually persists -- the sanitizer at
    // lib/workflow/editor/sanitize-nodes.ts:233-238 nests actionType inside
    // data.config. Workflows saved through the UI will only ever match here.
    const nodes = [makeCanonicalWriteNode()];
    const result = generateCalldataForWorkflow(nodes, {});

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.to).toBe("0xContractAddress");
      expect(result.data).toBe("0xencodeddata");
      expect(result.value).toBe("0");
    }
  });

  it("calls encodeFunctionData with correct ABI, function name, and args", () => {
    const nodes = [makeWriteNode()];
    generateCalldataForWorkflow(nodes, {});

    expect(mockEncodeFunctionData).toHaveBeenCalledWith("transfer", [
      "0xRecipient",
      "1000",
    ]);
  });

  it("resolves {{@trigger:Trigger.recipient}} template from triggerInputs", () => {
    const nodes = [
      makeWriteNode({
        functionArgs: JSON.stringify(["{{@trigger:Trigger.recipient}}", "500"]),
      }),
    ];
    generateCalldataForWorkflow(nodes, { recipient: "0xResolvedAddress" });

    expect(mockEncodeFunctionData).toHaveBeenCalledWith("transfer", [
      "0xResolvedAddress",
      "500",
    ]);
  });

  it("converts ethValue '0.1' to wei string via parseEther", () => {
    const nodes = [makeWriteNode({ ethValue: "0.1" })];
    const result = generateCalldataForWorkflow(nodes, {});

    expect(mockParseEther).toHaveBeenCalledWith("0.1");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value).toBe("100000000000000000");
    }
  });

  it("returns value '0' when ethValue is missing", () => {
    const nodes = [makeWriteNode({ ethValue: undefined })];
    const result = generateCalldataForWorkflow(nodes, {});

    expect(mockParseEther).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value).toBe("0");
    }
  });

  it("returns value '0' when ethValue is empty string", () => {
    const nodes = [makeWriteNode({ ethValue: "" })];
    const result = generateCalldataForWorkflow(nodes, {});

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value).toBe("0");
    }
  });

  it("returns error when no write-contract node is found", () => {
    const nodes = [
      { id: "read-1", data: { actionType: "web3/read-contract", config: {} } },
    ];
    const result = generateCalldataForWorkflow(nodes, {});

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("No write action node found in workflow");
    }
  });

  it("returns error for empty nodes array", () => {
    const result = generateCalldataForWorkflow([], {});

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("No write action node found in workflow");
    }
  });

  it("returns error when ABI JSON is invalid", () => {
    const nodes = [makeWriteNode({ abi: "not valid json {{" })];
    const result = generateCalldataForWorkflow(nodes, {});

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("Invalid ABI JSON in workflow node");
    }
  });

  it("returns structured error when encodeFunctionData throws", () => {
    mockEncodeFunctionData.mockImplementation(() => {
      throw new Error("invalid argument type for uint256");
    });
    const nodes = [makeWriteNode()];
    const result = generateCalldataForWorkflow(nodes, {});

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Failed to encode function call");
      expect(result.error).toContain("invalid argument type for uint256");
    }
  });

  it("returns structured error when parseEther throws on bad ethValue", () => {
    mockParseEther.mockImplementation(() => {
      throw new Error("invalid decimal value");
    });
    const nodes = [makeWriteNode({ ethValue: "not-a-number" })];
    const result = generateCalldataForWorkflow(nodes, {});

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Invalid ethValue "not-a-number"');
      expect(result.error).toContain("invalid decimal value");
    }
  });

  it("returns error for unresolvable non-trigger template reference", () => {
    const nodes = [
      makeWriteNode({
        functionArgs: JSON.stringify(["{{@http-1:HTTP Request.data.value}}"]),
      }),
    ];
    const result = generateCalldataForWorkflow(nodes, {});

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Unresolvable template reference");
      expect(result.error).toContain("{{@http-1:HTTP Request.data.value}}");
    }
  });

  it("recognizes web3/write-contract action type", () => {
    const nodes = [makeWriteNode()];
    const result = generateCalldataForWorkflow(nodes, {});
    expect(result.success).toBe(true);
  });

  it("recognizes protocol/protocol-write action type", () => {
    const nodes = [
      {
        id: "proto-write-1",
        data: {
          actionType: "protocol/protocol-write",
          config: {
            contractAddress: "0xProtocolContract",
            network: "base",
            abi: SAMPLE_ABI,
            abiFunction: "transfer",
            functionArgs: JSON.stringify(["0xAddr", "100"]),
          },
        },
      },
    ];
    const result = generateCalldataForWorkflow(nodes, {});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.to).toBe("0xProtocolContract");
    }
  });

  it("uses the first write node when multiple nodes exist", () => {
    const nodes = [
      {
        id: "read-1",
        data: { actionType: "web3/read-contract", config: {} },
      },
      makeWriteNode({ contractAddress: "0xFirstWriteContract" }),
      makeWriteNode({ contractAddress: "0xSecondWriteContract" }),
    ];
    const result = generateCalldataForWorkflow(nodes, {});

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.to).toBe("0xFirstWriteContract");
    }
  });
});
