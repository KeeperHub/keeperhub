import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  buildSolanaEventPayload,
  serializeSolanaArg,
} from "../../src/decode/solana-event-serializer";

describe("serializeSolanaArg", () => {
  it("stringifies bigint", () => {
    expect(serializeSolanaArg(42n)).toEqual({ value: "42", type: "u64" });
  });

  it("stringifies a BN (Anchor integer) via its decimal form", () => {
    expect(serializeSolanaArg(new BN("18446744073709551615"))).toEqual({
      value: "18446744073709551615",
      type: "u64",
    });
  });

  it("renders a PublicKey as base58 (not its internal bignum)", () => {
    const key = new PublicKey("11111111111111111111111111111111");
    expect(serializeSolanaArg(key)).toEqual({
      value: "11111111111111111111111111111111",
      type: "publicKey",
    });
  });

  it("renders byte arrays as hex", () => {
    expect(serializeSolanaArg(new Uint8Array([1, 2, 255]))).toEqual({
      value: "0102ff",
      type: "bytes",
    });
  });

  it("maps arrays element-wise", () => {
    expect(serializeSolanaArg([new BN(1), new BN(2)])).toEqual({
      value: ["1", "2"],
      type: "array",
    });
  });

  it("recurses into nested structs", () => {
    const result = serializeSolanaArg({ amount: new BN(5), memo: "hi" });
    expect(result).toEqual({
      type: "object",
      value: {
        amount: { value: "5", type: "u64" },
        memo: { value: "hi", type: "string" },
      },
    });
  });
});

describe("buildSolanaEventPayload", () => {
  const base = {
    programId: "Prog1111111111111111111111111111111111111111",
    signature: "sig-abc",
    slot: 123,
    commitment: "confirmed",
    logs: ["Program log: hello"],
  };

  it("builds a raw payload with no eventName/events when none decoded", () => {
    const payload = buildSolanaEventPayload(base);
    expect(payload).toEqual({
      chainType: "solana",
      ...base,
    });
    expect(payload.eventName).toBeUndefined();
    expect(payload.events).toBeUndefined();
  });

  it("attaches typed eventName + serialized events when decoded", () => {
    const payload = buildSolanaEventPayload({
      ...base,
      eventName: "Deposited",
      decodedEvents: [{ name: "Deposited", data: { amount: new BN(7) } }],
    });
    expect(payload.eventName).toBe("Deposited");
    expect(payload.events).toEqual([
      { name: "Deposited", data: { amount: { value: "7", type: "u64" } } },
    ]);
  });

  it("omits events when the decoded list is empty", () => {
    const payload = buildSolanaEventPayload({ ...base, decodedEvents: [] });
    expect(payload.events).toBeUndefined();
  });
});
