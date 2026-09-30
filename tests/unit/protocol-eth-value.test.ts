/**
 * applyEthValueTransform, the one conversion every protocol-write entrance
 * shares (lib/execute/protocol-eth-value.ts). Run against the production
 * registry so it exercises the real layerzero/oft-send registration; the
 * assertions are on the numbers that come out, not on which function was
 * looked up, so a registration pointing at an identity function fails here.
 */

import { parseEther } from "ethers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@/protocols";

vi.mock("server-only", () => ({}));

const logUserError = vi.fn();
vi.mock("@/lib/logging", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/logging")>();
  return {
    ...actual,
    logUserError: (...args: unknown[]) => logUserError(...args),
  };
});

import {
  applyEthValueTransform,
  findProtocolAction,
  readPayableValue,
} from "@/lib/execute/protocol-eth-value";
import {
  registerEncodeTransform,
  unregisterEncodeTransform,
  weiToEther,
} from "@/lib/protocol-encode-transforms";
import { OFT_SEND_FIXTURE_FEE_WEI } from "@/protocols/layerzero";

const OFT_SEND = {
  protocolSlug: "layerzero",
  contractKey: "oft",
  functionName: "send",
};
// wrapped/wrap: payable, no ethValue transform registered.
const WRAP = {
  protocolSlug: "wrapped",
  contractKey: "weth",
  functionName: "deposit",
};

describe("findProtocolAction", () => {
  it("resolves by (contract, function) and returns nothing on drift", () => {
    expect(findProtocolAction(OFT_SEND)?.slug).toBe("oft-send");
    expect(findProtocolAction(WRAP)?.slug).toBe("wrap");
    expect(
      findProtocolAction({ ...OFT_SEND, functionName: "sendRenamed" })
    ).toBeUndefined();
    expect(
      findProtocolAction({ ...OFT_SEND, contractKey: "oftToken" })
    ).toBeUndefined();
  });
});

describe("readPayableValue", () => {
  const FEE = "218756042576226";

  it("reads the declared input on an action with payableValue.fromInput", () => {
    // The OFT send declares payableValue.fromInput: "nativeFee", so the
    // payable value is the fee argument itself and no ethValue is needed.
    expect(readPayableValue({ nativeFee: FEE }, OFT_SEND)).toEqual({
      ok: true,
      value: FEE,
      field: "nativeFee",
    });
  });

  it("accepts an ethValue equal to the declared input, and blank ones", () => {
    // Legacy callers that still send a separate ethValue are tolerated
    // when it says the same number, or when it is absent/blank.
    expect(
      readPayableValue({ nativeFee: FEE, ethValue: FEE }, OFT_SEND)
    ).toEqual({ ok: true, value: FEE, field: "nativeFee" });
    for (const blank of [undefined, null, "", "   "]) {
      expect(
        readPayableValue({ nativeFee: FEE, ethValue: blank }, OFT_SEND)
      ).toEqual({ ok: true, value: FEE, field: "nativeFee" });
    }
  });

  it("refuses an ethValue that differs from the declared input", () => {
    const out = readPayableValue({ nativeFee: FEE, ethValue: "1" }, OFT_SEND);
    expect(out.ok).toBe(false);
    expect((out as { error: string }).error).toMatch(
      /takes its value from "nativeFee"/
    );
  });

  it("reads ethValue, and nothing else, on an action without fromInput", () => {
    expect(readPayableValue({ ethValue: "0.25" }, WRAP)).toEqual({
      ok: true,
      value: "0.25",
      field: "ethValue",
    });
    // A config key spelled like the send's fee input is not a value source
    // here: without fromInput the only source is ethValue, exactly as
    // before the hook existed.
    expect(
      readPayableValue({ nativeFee: "999", ethValue: "0.25" }, WRAP)
    ).toEqual({ ok: true, value: "0.25", field: "ethValue" });
    // And on an unresolvable action the field is still ethValue, so a
    // wrong-unit error names the field the caller typed it into.
    expect(
      readPayableValue(
        { ethValue: "0.25" },
        { ...OFT_SEND, functionName: "sendRenamed" }
      )
    ).toEqual({ ok: true, value: "0.25", field: "ethValue" });
  });

  it("refuses a fromInput action that registers no weiToEther on ethValue", () => {
    // The fromInput value is an integer in wei and the core's field reads
    // ether, so the pairing is only safe when the action registers the
    // weiToEther conversion. Nothing at registration time forces it - the
    // invariants file checks the registry in CI - so the read is the
    // runtime guard of last resort. Drop the production registration for
    // one call to put oft-send in the state being refused.
    unregisterEncodeTransform("layerzero", "oft-send", "ethValue");
    try {
      const out = readPayableValue({ nativeFee: FEE }, OFT_SEND);
      expect(out.ok).toBe(false);
      expect((out as { error: string }).error).toMatch(
        /registers no weiToEther conversion/
      );
    } finally {
      registerEncodeTransform(
        "layerzero",
        "oft-send",
        "ethValue",
        weiToEther,
        "weiToEther"
      );
    }
  });
});

describe("applyEthValueTransform", () => {
  beforeEach(() => {
    logUserError.mockClear();
  });

  it("converts a wei string to ether on an action that registers weiToEther", () => {
    const out = applyEthValueTransform(OFT_SEND_FIXTURE_FEE_WEI, OFT_SEND);
    expect(out).toEqual({ ok: true, value: "0.01" });
    // Round-trips to the exact wei that went in.
    expect(parseEther("0.01")).toBe(BigInt(OFT_SEND_FIXTURE_FEE_WEI));
    expect(applyEthValueTransform("  218756042576226 ", OFT_SEND)).toEqual({
      ok: true,
      value: "0.000218756042576226",
    });
  });

  it("returns the value untouched, whatever its type, on an action with no transform", () => {
    expect(applyEthValueTransform("0.25", WRAP)).toEqual({
      ok: true,
      value: "0.25",
    });
    expect(applyEthValueTransform(" 0.25 ", WRAP)).toEqual({
      ok: true,
      value: " 0.25 ",
    });
    // Non-strings pass through as they always did; the callers decide what
    // to do with them (the step drops them, the route stringifies).
    expect(applyEthValueTransform(0.25, WRAP)).toEqual({
      ok: true,
      value: 0.25,
    });
    expect(applyEthValueTransform(undefined, WRAP)).toEqual({
      ok: true,
      value: undefined,
    });
  });

  it("passes an empty or absent value through without looking the action up", () => {
    const drifted = { ...OFT_SEND, functionName: "sendRenamed" };
    expect(applyEthValueTransform("", drifted)).toEqual({
      ok: true,
      value: "",
    });
    expect(applyEthValueTransform("   ", drifted)).toEqual({
      ok: true,
      value: "   ",
    });
    expect(applyEthValueTransform(undefined, drifted)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(applyEthValueTransform(null, drifted)).toEqual({
      ok: true,
      value: null,
    });
    expect(logUserError).not.toHaveBeenCalled();
  });

  it("refuses a present value on an action it cannot resolve, and logs it", () => {
    const drifted = { ...OFT_SEND, functionName: "sendRenamed" };
    const out = applyEthValueTransform(OFT_SEND_FIXTURE_FEE_WEI, drifted);
    expect(out.ok).toBe(false);
    expect((out as { error: string }).error).toMatch(
      /Refusing to send a payable value/
    );
    expect(logUserError).toHaveBeenCalledTimes(1);
    expect(logUserError.mock.calls[0][3]).toMatchObject({
      protocol_slug: "layerzero",
      function_name: "sendRenamed",
      contract_key: "oft",
    });
  });

  it("rejects ether typed into a wei field rather than misreading it", () => {
    expect(() => applyEthValueTransform("0.01", OFT_SEND)).toThrow(
      /integer wei/
    );
  });

  it("leaves an unresolved template for the executor", () => {
    expect(
      applyEthValueTransform(
        "{{@quote:OFT Quote Send.fee.nativeFee}}",
        OFT_SEND
      )
    ).toEqual({ ok: true, value: "{{@quote:OFT Quote Send.fee.nativeFee}}" });
  });

  // A workflow's template substitution stringifies, but a direct API caller
  // can send a JSON number. The digits of a safe integer are exact and are
  // converted; anything a double cannot hold exactly is refused rather than
  // rounded into a fee the contract rejects (or accepts at the wrong amount).
  it("converts a safe-integer number or a bigint on a wei field", () => {
    expect(applyEthValueTransform(218_756_042_576_226, OFT_SEND)).toEqual({
      ok: true,
      value: "0.000218756042576226",
    });
    expect(
      applyEthValueTransform(BigInt(OFT_SEND_FIXTURE_FEE_WEI), OFT_SEND)
    ).toEqual({ ok: true, value: "0.01" });
  });

  it("refuses a number that cannot carry exact wei on a wei field", () => {
    for (const n of [1e21, 2 ** 53, 0.01]) {
      const out = applyEthValueTransform(n, OFT_SEND);
      expect(out.ok, String(n)).toBe(false);
      expect((out as { error: string }).error).toMatch(/JSON number/);
    }
  });

  it("passes a number through untouched on an unresolvable action, as before", () => {
    // The #2322 refusal is for a non-empty STRING on an unresolvable
    // action. A number never reached the conversion before this helper
    // existed (the step dropped it, the route stringified it), and it
    // still does not: no transform can apply without an action, so the
    // value goes back unchanged and the caller keeps its old behaviour.
    const drifted = { ...OFT_SEND, functionName: "sendRenamed" };
    expect(applyEthValueTransform(1, drifted)).toEqual({ ok: true, value: 1 });
    expect(applyEthValueTransform(0, drifted)).toEqual({ ok: true, value: 0 });
    expect(applyEthValueTransform(BigInt(5), drifted)).toEqual({
      ok: true,
      value: BigInt(5),
    });
    expect(logUserError).not.toHaveBeenCalled();
  });

  it("keeps a zero or false value on a no-transform action untouched", () => {
    expect(applyEthValueTransform(0, WRAP)).toEqual({ ok: true, value: 0 });
    expect(applyEthValueTransform(false, WRAP)).toEqual({
      ok: true,
      value: false,
    });
    expect(applyEthValueTransform("0", WRAP)).toEqual({ ok: true, value: "0" });
  });
});
