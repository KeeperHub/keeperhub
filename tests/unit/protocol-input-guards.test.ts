import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { buildProtocolFunctionArgs } from "@/app/api/execute/_lib/protocol-function-args";
import { checkProtocolInputGuards } from "@/lib/protocol-input-guards";
import { registerProtocol } from "@/lib/protocol-registry";
import uniswapDef from "@/protocols/uniswap-v3";

const ZERO = "0x0000000000000000000000000000000000000000";
const WALLET = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

registerProtocol(uniswapDef);

describe("protocol input guards", () => {
  // collect() rewrites a zero recipient to the position manager itself and
  // its sweepToken is unrestricted, so the call succeeds and the fees go to
  // whoever sweeps first. Nothing else in the stack rejects it: the address
  // check is a shape check, and the zero address is a well-formed address.
  it("rejects the zero recipient on uniswap collect", () => {
    const result = checkProtocolInputGuards("uniswap", "collect", {
      tokenId: "1",
      recipient: ZERO,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.field).toBe("recipient");
      expect(result.error).toContain("zero address");
    }
  });

  it("rejects zero through surrounding whitespace and a 0X prefix", () => {
    // The zero address has no alphabetic hex digits, so case only matters on
    // the prefix. Both of these are values a user can paste.
    for (const written of [`  ${ZERO}  `, ZERO.replace("0x", "0X")]) {
      expect(
        checkProtocolInputGuards("uniswap", "collect", { recipient: written })
          .ok,
        written
      ).toBe(false);
    }
  });

  // Naming the position manager directly reaches the same end state as the
  // zero sentinel: the fees sit in a contract whose sweepToken is public.
  it("rejects the position manager itself when the chain is known", () => {
    const manager = uniswapDef.contracts.positionManager.addresses["1"];

    expect(
      checkProtocolInputGuards(
        "uniswap",
        "collect",
        { recipient: manager },
        { network: "1" }
      ).ok
    ).toBe(false);
    // Mixed case must not slip past the comparison.
    expect(
      checkProtocolInputGuards(
        "uniswap",
        "collect",
        { recipient: manager.toLowerCase() },
        { network: "1" }
      ).ok
    ).toBe(false);
    // A different chain's context leaves that address unremarkable.
    expect(
      checkProtocolInputGuards(
        "uniswap",
        "collect",
        { recipient: manager },
        { network: "8453" }
      ).ok
    ).toBe(true);
  });

  it("accepts a real recipient, mixed case included", () => {
    for (const recipient of [WALLET, WALLET.toLowerCase()]) {
      expect(
        checkProtocolInputGuards("uniswap", "collect", { recipient }).ok,
        recipient
      ).toBe(true);
    }
  });

  // A malformed address is the encoder's to reject, with its own message, and
  // a missing one is the required-field check's. Neither is this guard's job.
  // These all throw inside getAddress and are the encoder's to reject, with
  // its own message. Pinned so the next guard author sees the real boundary.
  it("leaves malformed and missing values to the checks that own them", () => {
    for (const recipient of [
      "not-an-address",
      "0x1234",
      "0x0",
      "0x00",
      "",
      undefined,
    ]) {
      expect(
        checkProtocolInputGuards("uniswap", "collect", { recipient }).ok,
        String(recipient)
      ).toBe(true);
    }
  });

  it("does not fire on other functions or other protocols", () => {
    expect(
      checkProtocolInputGuards("uniswap", "decreaseLiquidity", {
        recipient: ZERO,
      }).ok
    ).toBe(true);
    expect(
      checkProtocolInputGuards("aerodrome", "collect", { recipient: ZERO }).ok
    ).toBe(true);
  });
});

// The workflow write step and this route are the two places that build
// protocol call arguments, so the guard has to hold on both.
describe("direct-execute route arguments", () => {
  it("refuses a zero recipient before encoding collect", () => {
    const result = buildProtocolFunctionArgs(
      { tokenId: "1", recipient: ZERO, amount0Max: "1", amount1Max: "1" },
      "uniswap",
      "positionManager",
      "collect"
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.field).toBe("recipient");
    }
  });

  it("encodes collect with a real recipient", () => {
    const result = buildProtocolFunctionArgs(
      { tokenId: "1", recipient: WALLET, amount0Max: "1", amount1Max: "1" },
      "uniswap",
      "positionManager",
      "collect"
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.functionArgs).toBe(JSON.stringify(["1", WALLET, "1", "1"]));
    }
  });
});
