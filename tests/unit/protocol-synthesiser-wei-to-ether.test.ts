import { afterEach, describe, expect, it } from "vitest";
import {
  clearEncodeTransforms,
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
    const out = synthesiseProtocolTemplate(
      "chainlink/ccip-approve-bridge-token",
      { network: "11155111" }
    );
    expect(out).not.toBeNull();
    expect(out as string).toContain("BigInt(input.amount)");
  });
});
