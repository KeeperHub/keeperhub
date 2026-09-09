import { ethers } from "ethers";
import { describe, expect, it, vi } from "vitest";

// Mocked at the module boundary for the same reason as mcp-calldata.test.ts:
// the real module pulls in db and wallet helpers this encoding test does not
// need. ethers itself is real here, because the point is what it encodes.
vi.mock("@/plugins/web3/steps/batch-write-contract-core", () => ({
  buildCallsWithMeta: vi.fn(),
}));

import { generateCalldataForWorkflow } from "@/lib/mcp/calldata";

const CONTRACT = "0x1111111111111111111111111111111111111111";
const tuple = {
  name: "send",
  type: "function",
  stateMutability: "nonpayable",
  inputs: [
    {
      name: "params",
      type: "tuple",
      components: [
        { name: "id", type: "uint32" },
        { name: "to", type: "bytes32" },
      ],
    },
    { name: "recipient", type: "address" },
  ],
  outputs: [],
};
const scalar = {
  name: "send",
  type: "function",
  stateMutability: "nonpayable",
  inputs: [{ name: "amount", type: "uint256" }],
  outputs: [],
};
const tupleArgs = [[7, `0x${"11".repeat(32)}`], `0x${"22".repeat(20)}`];

function nodes(abi: unknown[], abiFunction: string, args: unknown[]) {
  return [
    {
      id: "write-1",
      data: {
        actionType: "web3/write-contract",
        config: {
          contractAddress: CONTRACT,
          network: "base",
          abi: JSON.stringify(abi),
          abiFunction,
          functionArgs: JSON.stringify(args),
          ethValue: "",
        },
      },
    },
  ];
}

describe("generateCalldataForWorkflow function keys", () => {
  const expected = new ethers.Interface([tuple, scalar]).encodeFunctionData(
    "send((uint32,bytes32),address)",
    tupleArgs
  );

  it.each(["send(tuple,address)", "send((uint32,bytes32),address)"])(
    "encodes the saved key %s the way the workflow engine resolves it",
    (key) => {
      const result = generateCalldataForWorkflow(
        nodes([tuple, scalar], key, tupleArgs),
        {}
      );
      expect(result).toMatchObject({ success: true, to: CONTRACT });
      if (result.success) {
        expect(result.data).toBe(expected);
      }
    }
  );

  it("still accepts a bare name that identifies one function", () => {
    const result = generateCalldataForWorkflow(
      nodes([tuple], "send", tupleArgs),
      {}
    );
    expect(result).toMatchObject({ success: true, data: expected });
  });

  it("names the overloads instead of encoding an arbitrary one for a bare name", () => {
    const result = generateCalldataForWorkflow(
      nodes([tuple, scalar], "send", [1]),
      {}
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("matches 2 overloads");
      expect(result.error).toContain("send((uint32,bytes32),address)");
      expect(result.error).toContain("send(uint256)");
    }
  });

  const humanTuple =
    "function send((uint32 id, bytes32 to) params, address recipient)";

  it.each([
    ["a human-readable ABI", [humanTuple]],
    ["a mixed ABI", [humanTuple, scalar]],
    [
      "a function beside a string ethers cannot parse",
      ["not a fragment at all", humanTuple],
    ],
  ])("encodes a legacy tuple key against %s", (_label, abi) => {
    const warn = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const result = generateCalldataForWorkflow(
      nodes(abi, "send(tuple,address)", tupleArgs),
      {}
    );
    expect(result).toMatchObject({ success: true, data: expected });
    warn.mockRestore();
  });

  it("reports a function missing from a human-readable ABI as not found", () => {
    const result = generateCalldataForWorkflow(
      nodes([humanTuple], "burn", []),
      {}
    );
    expect(result).toMatchObject({
      success: false,
      error: "Function 'burn' not found in ABI",
    });
  });

  it("reports a missing function and a non-array ABI as such", () => {
    const missing = generateCalldataForWorkflow(nodes([tuple], "burn", []), {});
    expect(missing).toMatchObject({
      success: false,
      error: "Function 'burn' not found in ABI",
    });
    const object = generateCalldataForWorkflow(
      [
        {
          id: "write-1",
          data: {
            actionType: "web3/write-contract",
            config: {
              contractAddress: CONTRACT,
              abi: JSON.stringify({ not: "an array" }),
              abiFunction: "send",
            },
          },
        },
      ],
      {}
    );
    expect(object).toMatchObject({
      success: false,
      error: "Invalid ABI JSON in workflow node",
    });
  });
});
