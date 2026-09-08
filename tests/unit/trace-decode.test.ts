import { ethers } from "ethers";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  decodeFlatCall,
  type FlatCall,
  findDecodedCalls,
  flattenCallTree,
  type RawCallFrame,
  resolveExecutedCall,
  type TraceProvider,
  traceTransactionCallTree,
} from "@/lib/web3/trace-decode";

type SendFn = TraceProvider["send"];

const WRAPPER = "0x00000000000000000000000000000000000000aa";
const TARGET = "0x00000000000000000000000000000000000000bb";
const RECIPIENT = "0x00000000000000000000000000000000000000cc";
const RELAYER = "0x00000000000000000000000000000000000000ee";

const IFACE = new ethers.Interface([
  "function transfer(address to, uint256 amount)",
  "function schedule()",
]);

const transferData = IFACE.encodeFunctionData("transfer", [
  RECIPIENT,
  BigInt(1000),
]);
const scheduleData = IFACE.encodeFunctionData("schedule", []);

/** A sponsored tx: relayer -> wrapper.execute -> target.transfer(...) */
function sponsoredTree(): RawCallFrame {
  return {
    type: "CALL",
    from: RELAYER,
    to: WRAPPER,
    value: "0x0",
    input: "0x9aefaff800",
    calls: [
      {
        type: "STATICCALL",
        from: WRAPPER,
        to: "0x0000000000000000000000000000000000000001",
        input: "0xdeadbeef",
      },
      {
        type: "CALL",
        from: WRAPPER,
        to: TARGET,
        value: "0x0",
        input: transferData,
      },
    ],
  };
}

describe("trace-decode", () => {
  describe("flattenCallTree", () => {
    it("flattens depth-first with depth and lowercased addresses", () => {
      const flat = flattenCallTree(sponsoredTree());
      expect(flat).toHaveLength(3);
      expect(flat[0]).toMatchObject({ to: WRAPPER, depth: 0, type: "CALL" });
      expect(flat[1]).toMatchObject({ depth: 1, type: "STATICCALL" });
      expect(flat[2]).toMatchObject({ to: TARGET, depth: 1, type: "CALL" });
    });

    it("returns empty array for null root", () => {
      expect(flattenCallTree(null)).toEqual([]);
    });

    it("marks frames with an error as reverted", () => {
      const flat = flattenCallTree({
        type: "CALL",
        to: TARGET,
        input: scheduleData,
        error: "execution reverted",
      });
      expect(flat[0].reverted).toBe(true);
    });

    it("propagates revert to child frames when parent reverts", () => {
      const tree: RawCallFrame = {
        type: "CALL",
        to: WRAPPER,
        input: "0x00",
        error: "execution reverted",
        calls: [{ type: "CALL", to: TARGET, input: transferData }],
      };
      const flat = flattenCallTree(tree);
      expect(flat[0].reverted).toBe(true);
      expect(flat[1].reverted).toBe(true);
    });

    it("does not mark child reverted when only the child reverts, not parent", () => {
      const tree: RawCallFrame = {
        type: "CALL",
        to: WRAPPER,
        input: "0x00",
        calls: [
          { type: "CALL", to: TARGET, input: transferData, error: "reverted" },
          { type: "CALL", to: TARGET, input: scheduleData },
        ],
      };
      const flat = flattenCallTree(tree);
      expect(flat[0].reverted).toBe(false);
      expect(flat[1].reverted).toBe(true);
      expect(flat[2].reverted).toBe(false);
    });
  });

  describe("decodeFlatCall", () => {
    const base: FlatCall = {
      type: "CALL",
      from: WRAPPER,
      to: TARGET,
      value: "0x0",
      input: transferData,
      depth: 1,
      reverted: false,
    };

    it("decodes a matching function with named args", () => {
      const decoded = decodeFlatCall(base, IFACE);
      expect(decoded?.functionName).toBe("transfer");
      expect(decoded?.args.to.toLowerCase()).toBe(RECIPIENT);
      expect(decoded?.args.amount).toBe("1000");
    });

    it("returns null for non-decodable call types", () => {
      expect(decodeFlatCall({ ...base, type: "CREATE" }, IFACE)).toBeNull();
    });

    it("returns null for empty/short calldata", () => {
      expect(decodeFlatCall({ ...base, input: "0x" }, IFACE)).toBeNull();
    });

    it("returns null when calldata matches no ABI function", () => {
      expect(
        decodeFlatCall({ ...base, input: "0x12345678" }, IFACE)
      ).toBeNull();
    });
  });

  describe("findDecodedCalls", () => {
    it("finds the internal call to the target", () => {
      const matches = findDecodedCalls(sponsoredTree(), {
        target: TARGET,
        iface: IFACE,
        functionName: "transfer",
      });
      expect(matches).toHaveLength(1);
      expect(matches[0].functionName).toBe("transfer");
    });

    it("respects positional arg filter with wildcards", () => {
      const wrong = findDecodedCalls(sponsoredTree(), {
        target: TARGET,
        iface: IFACE,
        functionName: "transfer",
        filterArgs: ["0x00000000000000000000000000000000000000ff", ""],
      });
      expect(wrong).toHaveLength(0);

      const right = findDecodedCalls(sponsoredTree(), {
        target: TARGET,
        iface: IFACE,
        functionName: "transfer",
        filterArgs: [RECIPIENT, ""],
      });
      expect(right).toHaveLength(1);
    });

    it("excludes reverted frames unless requested", () => {
      const tree: RawCallFrame = {
        type: "CALL",
        to: WRAPPER,
        input: "0x00",
        calls: [
          { type: "CALL", to: TARGET, input: scheduleData, error: "reverted" },
        ],
      };
      expect(
        findDecodedCalls(tree, { target: TARGET, iface: IFACE })
      ).toHaveLength(0);
      expect(
        findDecodedCalls(tree, {
          target: TARGET,
          iface: IFACE,
          includeReverted: true,
        })
      ).toHaveLength(1);
    });
  });

  describe("resolveExecutedCall", () => {
    it("unwraps a sponsored tx and flags it sponsored", async () => {
      const provider = {
        send: vi.fn<SendFn>().mockResolvedValue(sponsoredTree()),
      };
      const result = await resolveExecutedCall(provider, "0xhash", {
        target: TARGET,
        iface: IFACE,
        functionName: "transfer",
      });
      expect(provider.send).toHaveBeenCalledWith("debug_traceTransaction", [
        "0xhash",
        { tracer: "callTracer" },
      ]);
      expect(result).toMatchObject({
        contractAddress: TARGET,
        functionName: "transfer",
        sponsored: true,
        topLevelTo: WRAPPER,
        reverted: false,
      });
    });

    it("flags a direct (non-wrapped) tx as not sponsored", async () => {
      const directTree: RawCallFrame = {
        type: "CALL",
        from: RELAYER,
        to: TARGET,
        input: scheduleData,
      };
      const provider = { send: vi.fn<SendFn>().mockResolvedValue(directTree) };
      const result = await resolveExecutedCall(provider, "0xhash", {
        target: TARGET,
        iface: IFACE,
        functionName: "schedule",
      });
      expect(result?.sponsored).toBe(false);
      expect(result?.topLevelTo).toBe(TARGET);
    });

    it("returns null when tracing is unavailable", async () => {
      const provider = {
        send: vi.fn<SendFn>().mockRejectedValue(new Error("method not found")),
      };
      const result = await resolveExecutedCall(provider, "0xhash", {
        target: TARGET,
        iface: IFACE,
      });
      expect(result).toBeNull();
    });
  });

  describe("traceTransactionCallTree", () => {
    let provider: { send: ReturnType<typeof vi.fn<SendFn>> };

    beforeEach(() => {
      provider = { send: vi.fn<SendFn>() };
    });

    it("returns the root frame on success", async () => {
      provider.send.mockResolvedValue(sponsoredTree());
      const root = await traceTransactionCallTree(provider, "0xhash");
      expect(root?.to).toBe(WRAPPER);
    });

    it("returns null when the RPC rejects (unsupported method)", async () => {
      provider.send.mockRejectedValue(new Error("does not exist"));
      expect(await traceTransactionCallTree(provider, "0xhash")).toBeNull();
    });

    it("returns null on a non-object result", async () => {
      provider.send.mockResolvedValue(null);
      expect(await traceTransactionCallTree(provider, "0xhash")).toBeNull();
    });
  });
});
