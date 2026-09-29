import { describe, expect, it, vi } from "vitest";

// Same boundary mock as mcp-calldata-function-key.test.ts: the real module
// pulls in db and wallet helpers this test does not need. ethers is real,
// because the point is the value it computes.
vi.mock("@/plugins/web3/steps/batch-write-contract-core", () => ({
  buildCallsWithMeta: vi.fn(),
}));

import { generateCalldataForWorkflow } from "@/lib/mcp/calldata";

// The value conversion keys off _actionType, not the ABI, so a one-function
// payable ABI keeps the test about the value.
const PAYABLE_ABI = JSON.stringify([
  {
    type: "function",
    name: "ping",
    inputs: [],
    outputs: [],
    stateMutability: "payable",
  },
]);

function node(actionType: string, config: Record<string, unknown>): unknown {
  return {
    id: "write-1",
    data: {
      actionType,
      config: {
        contractAddress: "0x1111111111111111111111111111111111111111",
        network: "ethereum",
        abi: PAYABLE_ABI,
        abiFunction: "ping",
        functionArgs: "[]",
        ...config,
      },
    },
  };
}

describe("generateCalldataForWorkflow: a protocol write's value field", () => {
  it("returns 0.0001 ETH for a 1e14-wei OFT Send fee, not 10^18 times it", () => {
    const result = generateCalldataForWorkflow(
      [
        node("protocol/protocol-write", {
          _actionType: "layerzero/oft-send",
          nativeFee: "100000000000000",
        }),
      ],
      {}
    );
    expect(result).toMatchObject({ success: true, value: "100000000000000" });
  });

  it("leaves a generic write-contract node's ether value exactly as before", () => {
    const result = generateCalldataForWorkflow(
      [node("web3/write-contract", { ethValue: "0.1" })],
      {}
    );
    expect(result).toMatchObject({
      success: true,
      value: "100000000000000000",
    });
  });

  it("refuses ether typed into the OFT Send wei field", () => {
    const result = generateCalldataForWorkflow(
      [
        node("protocol/protocol-write", {
          _actionType: "layerzero/oft-send",
          nativeFee: "0.001",
        }),
      ],
      {}
    );
    expect(result.success).toBe(false);
  });

  it("refuses a separate ethValue that disagrees with the OFT Send's nativeFee", () => {
    const result = generateCalldataForWorkflow(
      [
        node("protocol/protocol-write", {
          _actionType: "layerzero/oft-send",
          nativeFee: "100000000000000",
          ethValue: "1",
        }),
      ],
      {}
    );
    expect(result.success).toBe(false);
  });

  it("refuses a value on a protocol write it cannot resolve", () => {
    const result = generateCalldataForWorkflow(
      [node("protocol/protocol-write", { ethValue: "100000000000000" })],
      {}
    );
    expect(result.success).toBe(false);
  });

  it("keeps ether semantics for a protocol action with no transform", () => {
    const result = generateCalldataForWorkflow(
      [
        node("protocol/protocol-write", {
          _actionType: "wrapped/wrap",
          ethValue: "0.0001",
        }),
      ],
      {}
    );
    expect(result).toMatchObject({ success: true, value: "100000000000000" });
  });

  it("returns an error, not a number, for an unresolved template", () => {
    const result = generateCalldataForWorkflow(
      [
        node("protocol/protocol-write", {
          _actionType: "layerzero/oft-send",
          nativeFee: "{{@quote:OFT Quote Send.fee.nativeFee}}",
        }),
      ],
      {}
    );
    expect(result.success).toBe(false);
  });
});
