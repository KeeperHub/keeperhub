import { afterEach, describe, expect, it } from "vitest";
import {
  applyEncodeTransformsNamed,
  clearEncodeTransforms,
  getEncodeTransform,
  getEncodeTransformKind,
  registerEncodeTransform,
  weiToEther,
} from "@/lib/protocol-encode-transforms";

afterEach(() => {
  clearEncodeTransforms();
});

describe("registerEncodeTransform / getEncodeTransform", () => {
  it("registers and retrieves a transform", () => {
    const transform = (v: string): string => `padded:${v}`;
    registerEncodeTransform(
      "chainlink",
      "ccip-send",
      "receiver",
      transform,
      "padAddressToBytes"
    );
    const retrieved = getEncodeTransform("chainlink", "ccip-send", "receiver");
    expect(retrieved).toBe(transform);
  });

  it("returns undefined for unregistered transform", () => {
    const retrieved = getEncodeTransform("chainlink", "ccip-send", "receiver");
    expect(retrieved).toBeUndefined();
  });

  it("overwrites existing transform on re-register", () => {
    const first = (v: string): string => `first:${v}`;
    const second = (v: string): string => `second:${v}`;
    registerEncodeTransform(
      "proto",
      "action",
      "input",
      first,
      "padAddressToBytes"
    );
    registerEncodeTransform(
      "proto",
      "action",
      "input",
      second,
      "padAddressToBytes"
    );
    const retrieved = getEncodeTransform("proto", "action", "input");
    expect(retrieved).toBe(second);
  });
});

describe("getEncodeTransformKind", () => {
  it("returns the kind registered alongside the transform", () => {
    registerEncodeTransform(
      "chainlink",
      "ccip-send",
      "receiver",
      (v: string): string => v,
      "padAddressToBytes"
    );
    expect(getEncodeTransformKind("chainlink", "ccip-send", "receiver")).toBe(
      "padAddressToBytes"
    );
  });

  it("returns undefined for unregistered transform", () => {
    expect(
      getEncodeTransformKind("chainlink", "ccip-send", "receiver")
    ).toBeUndefined();
  });
});

describe("applyEncodeTransformsNamed", () => {
  it("passes through when no transforms registered", () => {
    const inputs = [
      { name: "to", value: "0xABC" },
      { name: "amount", value: "1000" },
    ];
    const result = applyEncodeTransformsNamed("proto", "action", inputs);
    expect(result).toBe(inputs);
  });

  it("applies registered transform to matching input", () => {
    registerEncodeTransform(
      "chainlink",
      "ccip-send",
      "receiver",
      (v: string): string => `0x${"0".repeat(24)}${v.slice(2)}`,
      "padAddressToBytes"
    );

    const inputs = [
      { name: "selector", value: "123" },
      { name: "receiver", value: "0xABCD" },
      { name: "data", value: "0x" },
    ];

    const result = applyEncodeTransformsNamed("chainlink", "ccip-send", inputs);
    expect(result[0].value).toBe("123");
    expect(result[1].value).toBe(`0x${"0".repeat(24)}ABCD`);
    expect(result[2].value).toBe("0x");
  });

  it("does not modify inputs for different action", () => {
    registerEncodeTransform(
      "chainlink",
      "ccip-send",
      "receiver",
      (v: string): string => `transformed:${v}`,
      "padAddressToBytes"
    );

    const inputs = [{ name: "receiver", value: "0xABC" }];
    const result = applyEncodeTransformsNamed(
      "chainlink",
      "ccip-get-fee",
      inputs
    );
    expect(result[0].value).toBe("0xABC");
  });
});

describe("weiToEther", () => {
  it("converts an integer wei string to a decimal ether string", () => {
    expect(weiToEther("1000000000000000000")).toBe("1.0");
    expect(weiToEther("218783648901826")).toBe("0.000218783648901826");
  });

  it("keeps full precision for one wei and for values above 2^53", () => {
    expect(weiToEther("1")).toBe("0.000000000000000001");
    const big = "123456789012345678901234567";
    expect(weiToEther(big)).toBe("123456789.012345678901234567");
  });

  it("leaves an unresolved template untouched", () => {
    expect(weiToEther("{{@quote:Quote.fee.nativeFee}}")).toBe(
      "{{@quote:Quote.fee.nativeFee}}"
    );
  });

  it("rejects a non-integer input with a clear error", () => {
    expect(() => weiToEther("1.5")).toThrow(/integer wei/);
    expect(() => weiToEther("abc")).toThrow(/integer wei/);
  });

  it("is registrable under the weiToEther kind", () => {
    registerEncodeTransform(
      "proto",
      "send",
      "ethValue",
      weiToEther,
      "weiToEther"
    );
    expect(getEncodeTransformKind("proto", "send", "ethValue")).toBe(
      "weiToEther"
    );
    const out = applyEncodeTransformsNamed("proto", "send", [
      { name: "ethValue", value: "2000000000000000000" },
    ]);
    expect(out[0].value).toBe("2.0");
  });
});
