import { describe, expect, it } from "vitest";
import {
  deserializeArg,
  deserializeEventTriggerData,
  deserializePrimitive,
} from "@/lib/utils";

/**
 * Hardening + parity tests for the event-trigger payload deserializer.
 *
 * Upstream event workers send each ABI-typed field as { type, value } and
 * sometimes ship literal "undefined" / "null" / "" strings for missing log
 * fields (e.g. logIndex on pending blocks). Prior behavior silently returned
 * those bad strings, poisoning downstream condition expressions with a
 * non-numeric value that fails opaquely or compares wrong. These tests pin
 * the new null-on-bad-input contract and characterize the happy paths.
 */

describe("deserializePrimitive", () => {
  describe("uint/int types", () => {
    it("converts a decimal numeric string to BigInt", () => {
      const result = deserializePrimitive("8187", "uint256");
      expect(result).toBe(BigInt(8187));
    });

    it("converts a hex-prefixed numeric string to BigInt", () => {
      const result = deserializePrimitive("0x18088b6", "uint256");
      expect(result).toBe(BigInt("0x18088b6"));
    });

    it("returns null for the literal string 'undefined' (worker bad-input shape)", () => {
      // Visible in production as logIndex: { type: 'uint256', value: 'undefined' }.
      // The pre-fix code returned the string 'undefined', poisoning downstream.
      expect(deserializePrimitive("undefined", "uint256")).toBeNull();
    });

    it("returns null for the literal string 'null'", () => {
      expect(deserializePrimitive("null", "uint256")).toBeNull();
    });

    it("returns null for empty string", () => {
      expect(deserializePrimitive("", "uint256")).toBeNull();
    });

    it("returns null for unparseable numerics like 'NaN'", () => {
      expect(deserializePrimitive("NaN", "uint256")).toBeNull();
    });

    it("handles int (signed) the same as uint", () => {
      expect(deserializePrimitive("-100", "int256")).toBe(BigInt(-100));
    });

    it("returns null when value is genuinely undefined", () => {
      expect(deserializePrimitive(undefined, "uint256")).toBeNull();
    });
  });

  describe("bool type", () => {
    it("converts 'true' to true", () => {
      expect(deserializePrimitive("true", "bool")).toBe(true);
    });

    it("converts 'false' to false", () => {
      expect(deserializePrimitive("false", "bool")).toBe(false);
    });

    it("returns null for missing/undefined inputs even on bool branch", () => {
      expect(deserializePrimitive("undefined", "bool")).toBeNull();
      expect(deserializePrimitive("", "bool")).toBeNull();
    });
  });

  describe("string/address/bytes types", () => {
    it("returns address strings as-is", () => {
      const addr = "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599";
      expect(deserializePrimitive(addr, "address")).toBe(addr);
    });

    it("returns string values as-is", () => {
      expect(deserializePrimitive("hello", "string")).toBe("hello");
    });

    it("returns bytes32 values as-is", () => {
      const hash =
        "0x65b5d8512d8b81b67b4d95bfcdddb44dea0a2424af795c6519e8989682a7026e";
      expect(deserializePrimitive(hash, "bytes32")).toBe(hash);
    });

    it("returns null for 'undefined' even on string branch", () => {
      // A missing address is still missing; we want a null, not the literal word.
      expect(deserializePrimitive("undefined", "address")).toBeNull();
    });
  });
});

describe("deserializeArg", () => {
  it("passes through values that lack the { type, value } shape", () => {
    expect(deserializeArg("plain-string")).toBe("plain-string");
    expect(deserializeArg(42)).toBe(42);
    expect(deserializeArg(null)).toBeNull();
  });

  it("unwraps a primitive { type, value }", () => {
    expect(deserializeArg({ type: "uint256", value: "8187" })).toBe(
      BigInt(8187)
    );
  });

  it("recursively unwraps a uint256[] array", () => {
    const result = deserializeArg({
      type: "uint256[]",
      value: ["10", "20", "30"],
    });
    expect(result).toEqual([BigInt(10), BigInt(20), BigInt(30)]);
  });

  it("recursively unwraps a tuple", () => {
    const result = deserializeArg({
      type: "tuple",
      value: {
        amount: { type: "uint256", value: "500" },
        recipient: { type: "address", value: "0xabc" },
      },
    });
    expect(result).toEqual({ amount: BigInt(500), recipient: "0xabc" });
  });

  it("handles fixed-size arrays (uint256[3])", () => {
    const result = deserializeArg({
      type: "uint256[3]",
      value: ["1", "2", "3"],
    });
    expect(result).toEqual([BigInt(1), BigInt(2), BigInt(3)]);
  });

  it("propagates the null-on-bad-input behavior through arrays", () => {
    // A poisoned element should become null, not the literal 'undefined' string.
    const result = deserializeArg({
      type: "uint256[]",
      value: ["100", "undefined", "300"],
    });
    expect(result).toEqual([BigInt(100), null, BigInt(300)]);
  });
});

describe("deserializeEventTriggerData", () => {
  it("flattens args { from, to, value } from the { type, value } wrapper", () => {
    const input = {
      args: {
        from: {
          type: "address",
          value: "0x000000000004444c5dc75cB358380D2e3dE08A90",
        },
        to: {
          type: "address",
          value: "0xB33BfC8c9f2dE3F6F9c45a2e7CB6F2bC246A52E",
        },
        value: { type: "uint256", value: "3462658346530114341788" },
      },
      eventName: "Transfer",
    };

    const result = deserializeEventTriggerData(input);

    expect(result.args).toEqual({
      from: "0x000000000004444c5dc75cB358380D2e3dE08A90",
      to: "0xB33BfC8c9f2dE3F6F9c45a2e7CB6F2bC246A52E",
      value: BigInt("3462658346530114341788"),
    });
    // Non-typed top-level fields stay as-is.
    expect(result.eventName).toBe("Transfer");
  });

  it("deserializes blockNumber / logIndex / transactionIndex when wrapped", () => {
    const input = {
      blockNumber: { type: "uint256", value: "0x18088b6" },
      transactionIndex: { type: "uint256", value: "112" },
    };

    const result = deserializeEventTriggerData(input);
    expect(result.blockNumber).toBe(BigInt("0x18088b6"));
    expect(result.transactionIndex).toBe(BigInt(112));
  });

  it("yields null (not the literal string) for logIndex='undefined' from the worker", () => {
    // This is the exact bug shape we hit in production -- pending-block events
    // arriving with a logIndex.value of the string "undefined".
    const input = {
      logIndex: { type: "uint256", value: "undefined" },
    };

    const result = deserializeEventTriggerData(input);
    expect(result.logIndex).toBeNull();
  });

  it("keeps eventName / transactionHash / blockHash / address as-is (not wrapped types)", () => {
    const input = {
      eventName: "Transfer",
      transactionHash: "0xd37a311810bc65136e",
      blockHash: "0x17f7b18a1b31",
      address: "0x56072c95faa701256",
    };

    const result = deserializeEventTriggerData(input);
    expect(result).toEqual(input);
  });

  it("handles an empty input without throwing", () => {
    expect(deserializeEventTriggerData({})).toEqual({});
  });

  it("does not crash when args is missing entirely", () => {
    const input = {
      eventName: "Burn",
      address: "0xabc",
    };
    expect(() => deserializeEventTriggerData(input)).not.toThrow();
  });
});
