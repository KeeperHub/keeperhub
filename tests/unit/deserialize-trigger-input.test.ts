import { describe, expect, it } from "vitest";
import { deserializeTriggerInput } from "@/lib/utils";

/**
 * Guards the trigger-input deserialization gate: on-chain event triggers (Event
 * and Tempo Transfer) must unwrap the event worker's { value, type } arg
 * wrappers into real scalars, while every other trigger type passes through
 * untouched. Without the Transfer branch, `args.value` stays the wrapper object
 * and every condition comparing it comes out false.
 */

function arg(type: string, value: unknown): { type: string; value: unknown } {
  return { type, value };
}

const DEPOSIT = "0x45A302766ecf1081024dD617BD67DB2e8a75Af1C";
const SENDER = "0x6ecB9f603c8247e81FB2c0182Bea0558A65605Eb";
const MEMO =
  "0xef1ed7120155d45a41c86ee4a954f100000000000000000000ac35f060d7d958";

// The shape the event worker delivers for a Tempo TransferWithMemo: a top-level
// args map of { value, type } wrappers, plus numeric log fields that can be
// missing on pending blocks (logIndex arrives as the literal "undefined").
function tempoTransferInput(): Record<string, unknown> {
  return {
    args: {
      to: arg("address", DEPOSIT),
      from: arg("address", SENDER),
      value: arg("uint256", "100000"),
      memo: arg("bytes32", MEMO),
    },
    address: "0x20c0000000000000000000000000000000000000",
    blockHash: "0x8e7caf0937e3f67bd93f22486c302",
    logIndex: arg("uint256", "undefined"),
  };
}

describe("deserializeTriggerInput", () => {
  describe("on-chain event triggers (Event, Transfer)", () => {
    it.each([
      "Transfer",
      "Event",
    ])("%s: unwraps { value, type } args into real scalars", (triggerType: string) => {
      const result = deserializeTriggerInput(triggerType, tempoTransferInput());
      const args = result.args as Record<string, unknown>;
      expect(args.value).toBe(BigInt(100_000)); // uint256 -> BigInt
      expect(args.to).toBe(DEPOSIT); // address -> string as-is
      expect(args.from).toBe(SENDER);
      expect(args.memo).toBe(MEMO); // bytes32 -> string as-is
    });

    it("maps a missing numeric log field ('undefined') to null", () => {
      const result = deserializeTriggerInput("Transfer", tempoTransferInput());
      expect(result.logIndex).toBeNull();
    });

    it("keeps non-arg scalar fields untouched", () => {
      const result = deserializeTriggerInput("Transfer", tempoTransferInput());
      expect(result.address).toBe("0x20c0000000000000000000000000000000000000");
      expect(result.blockHash).toBe("0x8e7caf0937e3f67bd93f22486c302");
    });

    it("decodes bool args to booleans", () => {
      const result = deserializeTriggerInput("Transfer", {
        args: { ok: arg("bool", "true"), no: arg("bool", "false") },
      });
      const args = result.args as Record<string, unknown>;
      expect(args.ok).toBe(true);
      expect(args.no).toBe(false);
    });

    it("decodes uint arrays to BigInt arrays", () => {
      const result = deserializeTriggerInput("Transfer", {
        args: { amounts: arg("uint256[]", ["1", "2", "3"]) },
      });
      const args = result.args as Record<string, unknown>;
      expect(args.amounts).toEqual([BigInt(1), BigInt(2), BigInt(3)]);
    });

    it("marks null / 'null' / '' / unparseable typed args as null", () => {
      const result = deserializeTriggerInput("Transfer", {
        args: {
          a: arg("uint256", "null"),
          b: arg("uint256", ""),
          c: arg("address", null),
          d: arg("uint256", "not-a-number"),
        },
      });
      const args = result.args as Record<string, unknown>;
      expect(args.a).toBeNull();
      expect(args.b).toBeNull();
      expect(args.c).toBeNull();
      expect(args.d).toBeNull();
    });

    it("leaves already-plain arg values (not wrappers) as they are", () => {
      const result = deserializeTriggerInput("Transfer", {
        args: { s: "hello", n: 42, z: null },
      });
      const args = result.args as Record<string, unknown>;
      expect(args.s).toBe("hello");
      expect(args.n).toBe(42);
      expect(args.z).toBeNull();
    });

    it("returns a new object without mutating the raw input", () => {
      const input = tempoTransferInput();
      const result = deserializeTriggerInput("Transfer", input);
      expect(result).not.toBe(input);
      const rawArgs = input.args as Record<string, { value: unknown }>;
      expect(rawArgs.value.value).toBe("100000");
    });
  });

  describe("non-event triggers pass through untouched", () => {
    it.each([
      "Manual",
      "Schedule",
      "Webhook",
      "Block",
      undefined,
    ])("%s: returns the input by reference with wrappers intact", (triggerType:
      | string
      | undefined) => {
      const input = tempoTransferInput();
      const result = deserializeTriggerInput(triggerType, input);
      expect(result).toBe(input);
      const args = result.args as Record<string, { value: unknown }>;
      expect(args.value.value).toBe("100000");
    });
  });
});
