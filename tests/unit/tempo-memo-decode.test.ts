import { describe, expect, it } from "vitest";
import { decodeMemoText, deserializeTriggerInput } from "@/lib/utils";

// encodeBytes32String("INV-1042") — utf8 right-padded to 32 bytes.
const INV_MEMO =
  "0x494e562d31303432000000000000000000000000000000000000000000000000";
// encodeBytes32String("Pay #7").
const PUNCT_MEMO =
  "0x5061792023370000000000000000000000000000000000000000000000000000";
// A real 32-byte hash memo (not printable text).
const HASH_MEMO =
  "0xef1ed7120155d45a41c86ee4a954f100000000000000000000ac35f060d7d958";
const EMPTY_MEMO = `0x${"0".repeat(64)}`;

describe("decodeMemoText", () => {
  it("decodes a right-padded utf8 bytes32 memo to its text", () => {
    expect(decodeMemoText(INV_MEMO)).toBe("INV-1042");
  });

  it("decodes memos with spaces and punctuation", () => {
    expect(decodeMemoText(PUNCT_MEMO)).toBe("Pay #7");
  });

  it("returns null for an all-zero (empty) memo", () => {
    expect(decodeMemoText(EMPTY_MEMO)).toBeNull();
  });

  it("returns null for a non-text (hash) memo", () => {
    expect(decodeMemoText(HASH_MEMO)).toBeNull();
  });

  it("returns null for a non-bytes32 or non-string value", () => {
    expect(decodeMemoText("0x1234")).toBeNull();
    expect(decodeMemoText(1234)).toBeNull();
    expect(decodeMemoText(null)).toBeNull();
    expect(decodeMemoText(undefined)).toBeNull();
  });
});

describe("deserializeTriggerInput exposes args.memoText for the Transfer trigger", () => {
  it("sets memoText from the decoded memo and keeps memo as the canonical hex", () => {
    const result = deserializeTriggerInput("Transfer", {
      args: {
        memo: { type: "bytes32", value: INV_MEMO },
        value: { type: "uint256", value: "500000000" },
      },
    });
    const args = result.args as Record<string, unknown>;
    expect(args.memoText).toBe("INV-1042");
    expect(args.memo).toBe(INV_MEMO);
    expect(args.value).toBe(BigInt(500_000_000));
  });

  it("sets memoText to null for a non-text hash memo", () => {
    const result = deserializeTriggerInput("Transfer", {
      args: { memo: { type: "bytes32", value: HASH_MEMO } },
    });
    expect((result.args as Record<string, unknown>).memoText).toBeNull();
  });

  it("does not add memoText for the generic Event trigger", () => {
    const result = deserializeTriggerInput("Event", {
      args: { memo: { type: "bytes32", value: INV_MEMO } },
    });
    expect("memoText" in (result.args as Record<string, unknown>)).toBe(false);
  });
});
