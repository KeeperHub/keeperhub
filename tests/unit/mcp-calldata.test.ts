import { beforeEach, describe, expect, it, vi } from "vitest";

// hoisted mocks
const { mockEncodeFunctionData, mockParseEther, mockBuildCallsWithMeta } =
  vi.hoisted(() => {
    const encodeFunctionData = vi.fn();
    const parseEther = vi.fn();
    const buildCallsWithMeta = vi.fn();
    return {
      mockEncodeFunctionData: encodeFunctionData,
      mockParseEther: parseEther,
      mockBuildCallsWithMeta: buildCallsWithMeta,
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
      // Faithful enough to exercise the contract-address guard: the real
      // ethers.isAddress rejects anything that is not 20 hex bytes, and the
      // guard is the thing standing between a malformed node and a paid-for
      // unusable response.
      isAddress: (value: unknown): boolean =>
        typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value),
    },
  };
});

// Mocked at the module boundary, same reason as gas-estimate-batch-write.test.ts.
// The real module transitively imports db, wallet-helpers, chain-adapter, and
// more, none of which are available in this pure encoding focused test.
vi.mock("@/plugins/web3/steps/batch-write-contract-core", () => ({
  buildCallsWithMeta: (...args: unknown[]) => mockBuildCallsWithMeta(...args),
}));

import { MULTICALL3_ADDRESS } from "@/lib/contracts/multicall3";
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
        contractAddress: "0x1111111111111111111111111111111111111111",
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
        contractAddress: "0x1111111111111111111111111111111111111111",
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
      expect(result.to).toBe("0x1111111111111111111111111111111111111111");
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
      expect(result.to).toBe("0x1111111111111111111111111111111111111111");
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

  // A write node with a missing or templated contractAddress used to produce
  // a "successful" response whose `to` key was simply absent. Now that a paid
  // write listing charges for this artifact and there is no refund path, an
  // unusable address must fail before any money can move.
  it.each([
    ["missing", undefined],
    ["an unresolved template", "{{@trigger:Trigger.contract}}"],
    ["a short hex string", "0x1234"],
    ["a non-string", 42],
  ])("rejects a contract address that is %s", (_label, contractAddress) => {
    const nodes = [
      makeWriteNode({ contractAddress } as Record<string, unknown>),
    ];
    const result = generateCalldataForWorkflow(nodes, {});

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Invalid or missing contract address");
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
            contractAddress: "0x2222222222222222222222222222222222222222",
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
      expect(result.to).toBe("0x2222222222222222222222222222222222222222");
    }
  });

  it("uses the first write node when multiple nodes exist", () => {
    const nodes = [
      {
        id: "read-1",
        data: { actionType: "web3/read-contract", config: {} },
      },
      makeWriteNode({
        contractAddress: "0x3333333333333333333333333333333333333333",
      }),
      makeWriteNode({
        contractAddress: "0x4444444444444444444444444444444444444444",
      }),
    ];
    const result = generateCalldataForWorkflow(nodes, {});

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.to).toBe("0x3333333333333333333333333333333333333333");
    }
  });
});

function makeBatchNode(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: "batch-write-1",
    data: {
      actionType: "web3/batch-write-contract",
      config: {
        network: "base",
        calls: JSON.stringify([
          {
            contractAddress: "0xA",
            abi: SAMPLE_ABI,
            abiFunction: "transfer",
            args: ["0xA", "1"],
          },
        ]),
        isolateCallFailures: "true",
        ...overrides,
      },
    },
  };
}

const BATCH_CALL3 = {
  target: "0xA",
  allowFailure: true,
  callData: "0xcalldata",
};

describe("generateCalldataForWorkflow, batch-write-contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEncodeFunctionData.mockReturnValue("0xaggregate3data");
    mockBuildCallsWithMeta.mockReturnValue({ calls: [BATCH_CALL3] });
  });

  it("recognizes web3/batch-write-contract as a write action node", () => {
    const nodes = [makeBatchNode()];
    const result = generateCalldataForWorkflow(nodes, {});
    expect(result.success).toBe(true);
  });

  it("targets Multicall3, not the batched contracts, and encodes aggregate3", () => {
    const nodes = [makeBatchNode()];
    const result = generateCalldataForWorkflow(nodes, {});

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.to).toBe(MULTICALL3_ADDRESS);
      expect(result.data).toBe("0xaggregate3data");
      expect(result.value).toBe("0");
    }
    expect(mockEncodeFunctionData).toHaveBeenCalledWith("aggregate3", [
      [{ target: "0xA", allowFailure: true, callData: "0xcalldata" }],
    ]);
  });

  it("is the first-matched write node, ahead of a later real write-contract node", () => {
    // Unlike before batch-write-contract was calldata-generatable, it now
    // matches isWriteActionType like any other write node, so the normal
    // first-match rule applies to it too.
    const nodes = [
      makeBatchNode(),
      makeWriteNode({ contractAddress: "0xShouldNotBeUsed" }),
    ];
    const result = generateCalldataForWorkflow(nodes, {});

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.to).toBe(MULTICALL3_ADDRESS);
    }
  });

  it("passes calls and isolateCallFailures through to buildCallsWithMeta", () => {
    const nodes = [makeBatchNode({ isolateCallFailures: "false" })];
    generateCalldataForWorkflow(nodes, {});

    expect(mockBuildCallsWithMeta).toHaveBeenCalledWith({
      calls: [
        {
          contractAddress: "0xA",
          abi: SAMPLE_ABI,
          abiFunction: "transfer",
          args: ["0xA", "1"],
        },
      ],
      isolateCallFailures: "false",
    });
  });

  it("accepts calls as a native array, not just a JSON string", () => {
    const nodes = [
      makeBatchNode({
        calls: [
          {
            contractAddress: "0xA",
            abi: SAMPLE_ABI,
            abiFunction: "transfer",
            args: [],
          },
        ],
      }),
    ];
    const result = generateCalldataForWorkflow(nodes, {});
    expect(result.success).toBe(true);
  });

  it("resolves {{@trigger:Trigger.field}} references in a call's args before encoding", () => {
    const nodes = [
      makeBatchNode({
        calls: JSON.stringify([
          {
            contractAddress: "0xA",
            abi: SAMPLE_ABI,
            abiFunction: "transfer",
            args: ["{{@trigger:Trigger.recipient}}", "1"],
          },
        ]),
      }),
    ];
    generateCalldataForWorkflow(nodes, { recipient: "0xResolvedAddress" });

    expect(mockBuildCallsWithMeta).toHaveBeenCalledWith({
      calls: [
        {
          contractAddress: "0xA",
          abi: SAMPLE_ABI,
          abiFunction: "transfer",
          args: ["0xResolvedAddress", "1"],
        },
      ],
      isolateCallFailures: "true",
    });
  });

  it("returns error for an unresolvable non-trigger template in a call's args", () => {
    const nodes = [
      makeBatchNode({
        calls: JSON.stringify([
          {
            contractAddress: "0xA",
            abi: SAMPLE_ABI,
            abiFunction: "transfer",
            args: ["{{@http-1:HTTP Request.data.value}}"],
          },
        ]),
      }),
    ];
    const result = generateCalldataForWorkflow(nodes, {});

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Unresolvable template reference");
    }
    expect(mockBuildCallsWithMeta).not.toHaveBeenCalled();
  });

  it("propagates a buildCallsWithMeta validation error", () => {
    mockBuildCallsWithMeta.mockReturnValue({
      calls: [],
      error: "Call at index 0 missing contractAddress",
    });
    const nodes = [makeBatchNode()];
    const result = generateCalldataForWorkflow(nodes, {});

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("Call at index 0 missing contractAddress");
    }
  });

  it("returns error when calls is missing", () => {
    const nodes = [makeBatchNode({ calls: undefined })];
    const result = generateCalldataForWorkflow(nodes, {});

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("Missing calls in workflow node");
    }
    expect(mockBuildCallsWithMeta).not.toHaveBeenCalled();
  });

  it("returns error when calls JSON is malformed", () => {
    const nodes = [makeBatchNode({ calls: "not valid json {{" })];
    const result = generateCalldataForWorkflow(nodes, {});

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Invalid Calls JSON");
    }
  });

  it("returns structured error when the aggregate3 encode throws", () => {
    mockEncodeFunctionData.mockImplementation(() => {
      throw new Error("bad Call3 shape");
    });
    const nodes = [makeBatchNode()];
    const result = generateCalldataForWorkflow(nodes, {});

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Failed to encode batch call");
      expect(result.error).toContain("bad Call3 shape");
    }
  });
});
