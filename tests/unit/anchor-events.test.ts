import { BN, BorshCoder, type Idl } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockLogUserError = vi.fn();
vi.mock("@/lib/logging", () => ({
  ErrorCategory: { VALIDATION: "validation" },
  logUserError: (...args: unknown[]) => mockLogUserError(...args),
}));

import {
  AnchorEventDecoder,
  createEventDecoder,
} from "@/lib/web3/anchor-events";

const PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const OTHER_PROGRAM_ID = "So11111111111111111111111111111111111111112";

const DEPOSITED_DISCRIMINATOR = [11, 22, 33, 44, 55, 66, 77, 88];
const IDL: Idl = {
  address: "11111111111111111111111111111111",
  metadata: { name: "test_program", version: "0.1.0", spec: "0.1.0" },
  instructions: [],
  accounts: [],
  events: [{ name: "Deposited", discriminator: DEPOSITED_DISCRIMINATOR }],
  types: [
    {
      name: "Deposited",
      type: { kind: "struct", fields: [{ name: "amount", type: "u64" }] },
    },
  ],
};

function depositedLog(amount: number, prefix = "Program data: "): string {
  const coder = new BorshCoder(IDL);
  const encoded = coder.types.encode("Deposited", { amount: new BN(amount) });
  const blob = Buffer.concat([Buffer.from(DEPOSITED_DISCRIMINATOR), encoded]);
  return `${prefix}${blob.toString("base64")}`;
}

describe("createEventDecoder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when no IDL is provided (raw mode)", () => {
    expect(createEventDecoder(undefined, PROGRAM_ID)).toBeNull();
    expect(mockLogUserError).not.toHaveBeenCalled();
  });

  it("returns null and logs for malformed JSON (raw mode)", () => {
    expect(createEventDecoder("{not json", PROGRAM_ID)).toBeNull();
    expect(mockLogUserError).toHaveBeenCalledTimes(1);
  });

  it("returns null and logs when the IDL has no events array", () => {
    const idlWithoutEvents = { ...IDL, events: undefined };
    expect(
      createEventDecoder(JSON.stringify(idlWithoutEvents), PROGRAM_ID)
    ).toBeNull();
    expect(mockLogUserError).toHaveBeenCalledTimes(1);
  });

  it("returns a decoder for a valid IDL", () => {
    expect(createEventDecoder(JSON.stringify(IDL), PROGRAM_ID)).toBeInstanceOf(
      AnchorEventDecoder
    );
    expect(mockLogUserError).not.toHaveBeenCalled();
  });
});

describe("AnchorEventDecoder.decodeLogs", () => {
  it("decodes an event on a well-formed 'Program data:' log line", () => {
    const decoder = createEventDecoder(JSON.stringify(IDL), PROGRAM_ID);
    const events = decoder?.decodeLogs([
      `Program ${PROGRAM_ID} invoke [1]`,
      "Program log: instruction: deposit",
      depositedLog(7),
      `Program ${PROGRAM_ID} success`,
    ]);
    expect(events).toHaveLength(1);
    expect(events?.[0].name).toBe("Deposited");
    expect(events?.[0].data.amount).toBe("7");
  });

  it("decodes an event on a bare 'Program log:' line while in-context", () => {
    const decoder = createEventDecoder(JSON.stringify(IDL), PROGRAM_ID);
    const events = decoder?.decodeLogs([
      `Program ${PROGRAM_ID} invoke [1]`,
      depositedLog(3, "Program log: "),
      `Program ${PROGRAM_ID} success`,
    ]);
    expect(events).toHaveLength(1);
    expect(events?.[0].data.amount).toBe("3");
  });

  it("ignores non-event log lines and returns nothing", () => {
    const decoder = createEventDecoder(JSON.stringify(IDL), PROGRAM_ID);
    const events = decoder?.decodeLogs([
      `Program ${PROGRAM_ID} invoke [1]`,
      "Program log: nothing here",
      `Program ${PROGRAM_ID} success`,
    ]);
    expect(events).toEqual([]);
  });

  it("skips data blobs that do not match this IDL's discriminator", () => {
    const decoder = createEventDecoder(JSON.stringify(IDL), PROGRAM_ID);
    const events = decoder?.decodeLogs([
      `Program ${PROGRAM_ID} invoke [1]`,
      `Program data: ${Buffer.from([0, 1, 2, 3]).toString("base64")}`,
      `Program ${PROGRAM_ID} success`,
    ]);
    expect(events).toEqual([]);
  });

  it("returns nothing when the log array does not open with a well-formed top-level invoke", () => {
    const decoder = createEventDecoder(JSON.stringify(IDL), PROGRAM_ID);
    expect(decoder?.decodeLogs([])).toEqual([]);
    expect(decoder?.decodeLogs(["Program log: stray line"])).toEqual([]);
  });

  it("does not attribute an event logged while a CPI'd program is executing", () => {
    const decoder = createEventDecoder(JSON.stringify(IDL), PROGRAM_ID);
    const events = decoder?.decodeLogs([
      `Program ${PROGRAM_ID} invoke [1]`,
      `Program ${OTHER_PROGRAM_ID} invoke [2]`,
      depositedLog(999),
      `Program ${OTHER_PROGRAM_ID} success`,
      depositedLog(1),
      `Program ${PROGRAM_ID} success`,
    ]);
    expect(events).toHaveLength(1);
    expect(events?.[0].data.amount).toBe("1");
  });

  it("resumes decoding this program's own logs after a CPI returns", () => {
    const decoder = createEventDecoder(JSON.stringify(IDL), PROGRAM_ID);
    const events = decoder?.decodeLogs([
      `Program ${PROGRAM_ID} invoke [1]`,
      depositedLog(1),
      `Program ${OTHER_PROGRAM_ID} invoke [2]`,
      `Program ${OTHER_PROGRAM_ID} success`,
      depositedLog(2),
      `Program ${PROGRAM_ID} success`,
    ]);
    expect(events?.map((e) => e.data.amount)).toEqual(["1", "2"]);
  });

  it("handles a second top-level instruction invoking the same program in one transaction", () => {
    const decoder = createEventDecoder(JSON.stringify(IDL), PROGRAM_ID);
    const events = decoder?.decodeLogs([
      `Program ${PROGRAM_ID} invoke [1]`,
      depositedLog(1),
      `Program ${PROGRAM_ID} success`,
      `Program ${PROGRAM_ID} invoke [1]`,
      depositedLog(2),
      `Program ${PROGRAM_ID} success`,
    ]);
    expect(events?.map((e) => e.data.amount)).toEqual(["1", "2"]);
  });

  it("normalizes a u64 field to a decimal string that survives JSON.stringify", () => {
    const decoder = createEventDecoder(JSON.stringify(IDL), PROGRAM_ID);
    const events = decoder?.decodeLogs([
      `Program ${PROGRAM_ID} invoke [1]`,
      depositedLog(123_456),
      `Program ${PROGRAM_ID} success`,
    ]);
    const amount = events?.[0].data.amount;
    expect(typeof amount).toBe("string");
    expect(amount).toBe("123456");
    expect(JSON.parse(JSON.stringify(events?.[0].data)).amount).toBe("123456");
  });
});

const TRADED_DISCRIMINATOR = [99, 98, 97, 96, 95, 94, 93, 92];
const WHIRLPOOL = "HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ";

// Covers a pubkey at every nesting Anchor produces: bare, inside a defined
// struct, inside a vec, and inside an option - plus a bytes field, whose
// Buffer leaks the same way a PublicKey does.
const PUBKEY_IDL: Idl = {
  address: "11111111111111111111111111111111",
  metadata: { name: "test_program", version: "0.1.0", spec: "0.1.0" },
  instructions: [],
  accounts: [],
  events: [{ name: "Traded", discriminator: TRADED_DISCRIMINATOR }],
  types: [
    {
      name: "Inner",
      type: {
        kind: "struct",
        fields: [{ name: "nested_key", type: "pubkey" }],
      },
    },
    {
      name: "Traded",
      type: {
        kind: "struct",
        fields: [
          { name: "whirlpool", type: "pubkey" },
          { name: "amount", type: "u64" },
          { name: "keys", type: { vec: "pubkey" } },
          { name: "maybe_key", type: { option: "pubkey" } },
          { name: "inner", type: { defined: { name: "Inner" } } },
          { name: "payload", type: "bytes" },
        ],
      },
    },
  ],
};

function tradedLog(): string {
  const coder = new BorshCoder(PUBKEY_IDL);
  const encoded = coder.types.encode("Traded", {
    whirlpool: new PublicKey(WHIRLPOOL),
    amount: new BN(42),
    keys: [new PublicKey(WHIRLPOOL)],
    maybe_key: new PublicKey(WHIRLPOOL),
    inner: { nested_key: new PublicKey(WHIRLPOOL) },
    payload: Buffer.from([1, 2, 3]),
  });
  const blob = Buffer.concat([Buffer.from(TRADED_DISCRIMINATOR), encoded]);
  return `Program data: ${blob.toString("base64")}`;
}

function decodeTraded(): Record<string, unknown> {
  const decoder = createEventDecoder(JSON.stringify(PUBKEY_IDL), PROGRAM_ID);
  const events = decoder?.decodeLogs([
    `Program ${PROGRAM_ID} invoke [1]`,
    tradedLog(),
    `Program ${PROGRAM_ID} success`,
  ]);
  expect(events).toHaveLength(1);
  return events?.[0].data as Record<string, unknown>;
}

describe("AnchorEventDecoder pubkey and bytes normalization", () => {
  it("normalizes a pubkey field to a base58 string, not a PublicKey instance", () => {
    const data = decodeTraded();
    expect(typeof data.whirlpool).toBe("string");
    expect(data.whirlpool).toBe(WHIRLPOOL);
  });

  it("normalizes pubkeys nested in a struct, a vec and an option", () => {
    const data = decodeTraded();
    expect((data.inner as Record<string, unknown>).nested_key).toBe(WHIRLPOOL);
    expect(data.keys).toEqual([WHIRLPOOL]);
    expect(data.maybe_key).toBe(WHIRLPOOL);
  });

  it("normalizes a bytes field to base64, not a raw Buffer", () => {
    const data = decodeTraded();
    expect(data.payload).toBe(Buffer.from([1, 2, 3]).toString("base64"));
  });

  // The regression this guards: PublicKey.toJSON() returns base58, so a raw
  // instance survives JSON.stringify looking correct. A structured-clone
  // boundary - which the executor crosses when scoping for-each outputs -
  // has no such escape hatch and deep-walks the instance into its internal
  // {"_bn":{"words":[...]}} representation instead.
  it("keeps every field JSON-safe across a structured clone", () => {
    const cloned = structuredClone(decodeTraded());
    expect(cloned).toEqual({
      whirlpool: WHIRLPOOL,
      amount: "42",
      keys: [WHIRLPOOL],
      maybe_key: WHIRLPOOL,
      inner: { nested_key: WHIRLPOOL },
      payload: Buffer.from([1, 2, 3]).toString("base64"),
    });
    expect(JSON.stringify(cloned)).not.toContain("_bn");
  });
});
