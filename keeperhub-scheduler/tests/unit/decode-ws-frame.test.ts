import { describe, expect, it } from "vitest";
import { decodeWsFrame } from "../../block-dispatcher/chain-monitor.js";

// The ws library can deliver a "message" event payload in any of these four
// shapes depending on its options and the size/fragmentation of the incoming
// frame. ethers v6 receives Buffer today, but the KEEP-570 diagnostic tap
// must not silently mis-decode if that ever changes - a wrong push count is
// worse than no diagnostic at all.
describe("decodeWsFrame", () => {
  it("returns the input when it is already a string", () => {
    expect(decodeWsFrame('{"method":"eth_subscription"}')).toBe(
      '{"method":"eth_subscription"}',
    );
  });

  it("decodes a Buffer as UTF-8", () => {
    expect(decodeWsFrame(Buffer.from("hello", "utf8"))).toBe("hello");
  });

  it("concatenates and decodes a fragmented Buffer[]", () => {
    expect(
      decodeWsFrame([Buffer.from("hel", "utf8"), Buffer.from("lo", "utf8")]),
    ).toBe("hello");
  });

  it("concatenates Buffer[] across a multi-byte UTF-8 boundary", () => {
    // 'é' is 0xC3 0xA9 in UTF-8. Split across two Buffers to verify the
    // decoder joins bytes before decoding rather than decoding each chunk
    // independently (which would corrupt the character).
    const a = Buffer.from([0xc3]);
    const b = Buffer.from([0xa9, 0x21]);
    expect(decodeWsFrame([a, b])).toBe("é!");
  });

  it("decodes an ArrayBuffer", () => {
    const arrayBuffer = new TextEncoder().encode("hello").buffer as ArrayBuffer;
    expect(decodeWsFrame(arrayBuffer)).toBe("hello");
  });

  it("returns null for shapes the tap does not understand", () => {
    expect(decodeWsFrame(42)).toBeNull();
    expect(decodeWsFrame(null)).toBeNull();
    expect(decodeWsFrame(undefined)).toBeNull();
    expect(decodeWsFrame({ message: "object, not bytes" })).toBeNull();
    // Array of non-Buffers (e.g. ws delivering parsed JSON via a typed
    // socket): not what the tap expects, must not be coerced.
    expect(decodeWsFrame([1, 2, 3])).toBeNull();
  });
});
