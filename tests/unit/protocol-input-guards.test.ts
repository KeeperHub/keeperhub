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

  it("rejects zero however it is written", () => {
    for (const written of [
      ZERO,
      `  ${ZERO}  `,
      ZERO.toUpperCase().replace("0X", "0x"),
    ]) {
      expect(
        checkProtocolInputGuards("uniswap", "collect", { recipient: written })
          .ok,
        written
      ).toBe(false);
    }
  });

  it("accepts a real recipient", () => {
    expect(
      checkProtocolInputGuards("uniswap", "collect", { recipient: WALLET }).ok
    ).toBe(true);
  });

  // A malformed address is the encoder's to reject, with its own message, and
  // a missing one is the required-field check's. Neither is this guard's job.
  it("leaves malformed and missing values to the checks that own them", () => {
    for (const recipient of ["not-an-address", "0x1234", "", undefined]) {
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
