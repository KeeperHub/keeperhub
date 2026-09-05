import { afterEach, describe, expect, it } from "vitest";
import {
  clearEncodeTransforms,
  getEncodeTransformKind,
  registerEncodeTransform,
  weiToEther,
} from "@/lib/protocol-encode-transforms";
import { synthesiseProtocolTemplate } from "@/lib/workflow/codegen/protocol-synthesiser";

afterEach(() => {
  clearEncodeTransforms();
});

describe("synthesiser: weiToEther kind", () => {
  it("preserves the raw expression for an ABI input registered under weiToEther", () => {
    registerEncodeTransform(
      "chainlink",
      "ccip-approve-bridge-token",
      "amount",
      weiToEther,
      "weiToEther"
    );
    expect(
      getEncodeTransformKind("chainlink", "ccip-approve-bridge-token", "amount")
    ).toBe("weiToEther");

    const out = synthesiseProtocolTemplate(
      "chainlink/ccip-approve-bridge-token",
      { network: "11155111" }
    );
    expect(out).not.toBeNull();
    expect(out as string).toContain("BigInt(input.amount)");
    // The emitted SDK must not convert: a leaked kind name or a stray
    // conversion call would both fail here.
    expect(out as string).not.toContain("formatEther");
  });
});
