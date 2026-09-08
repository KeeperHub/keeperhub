import { BN, BorshCoder, type Idl } from "@coral-xyz/anchor";
import { describe, expect, it } from "vitest";
import { createEventDecoder } from "../../src/decode/solana-idl";

// Minimal Anchor (0.30 IDL format) program with one event carrying a single
// u64 field and an explicit 8-byte discriminator.
const DISCRIMINATOR = [11, 22, 33, 44, 55, 66, 77, 88];
const IDL: Idl = {
  address: "11111111111111111111111111111111",
  metadata: { name: "test_program", version: "0.1.0", spec: "0.1.0" },
  instructions: [],
  accounts: [],
  events: [{ name: "Deposited", discriminator: DISCRIMINATOR }],
  types: [
    {
      name: "Deposited",
      type: { kind: "struct", fields: [{ name: "amount", type: "u64" }] },
    },
  ],
};

/**
 * Produce the `Program data: <base64>` log line an Anchor program would emit
 * for `Deposited { amount }`: the 8-byte event discriminator followed by the
 * Borsh-encoded struct. Built with Anchor's own coder so the layout matches
 * whatever version is installed, rather than hardcoding bytes.
 */
function anchorEventLog(amount: number): string {
  const coder = new BorshCoder(IDL);
  const encoded = coder.types.encode("Deposited", { amount: new BN(amount) });
  const blob = Buffer.concat([Buffer.from(DISCRIMINATOR), encoded]);
  return `Program data: ${blob.toString("base64")}`;
}

describe("createEventDecoder", () => {
  it("returns null when no IDL is provided (raw mode)", () => {
    expect(createEventDecoder(undefined, "wf")).toBeNull();
  });

  it("returns null for malformed JSON (raw mode)", () => {
    expect(createEventDecoder("{not json", "wf")).toBeNull();
  });
});

describe("AnchorEventDecoder.decodeLogs", () => {
  it("decodes an Anchor event from a Program data log line", () => {
    const decoder = createEventDecoder(JSON.stringify(IDL), "wf");
    expect(decoder).not.toBeNull();
    const events = decoder?.decodeLogs([
      "Program log: instruction: deposit",
      anchorEventLog(7),
      "Program log: success",
    ]);
    expect(events).toHaveLength(1);
    expect(events?.[0].name).toBe("Deposited");
    expect(String((events?.[0].data as { amount: unknown }).amount)).toBe("7");
  });

  it("ignores non-event log lines and returns nothing", () => {
    const decoder = createEventDecoder(JSON.stringify(IDL), "wf");
    const events = decoder?.decodeLogs([
      "Program log: nothing here",
      "Program invoke [1]",
    ]);
    expect(events).toEqual([]);
  });

  it("skips data blobs that do not match this IDL", () => {
    const decoder = createEventDecoder(JSON.stringify(IDL), "wf");
    const events = decoder?.decodeLogs([
      `Program data: ${Buffer.from([0, 1, 2, 3]).toString("base64")}`,
    ]);
    expect(events).toEqual([]);
  });
});
