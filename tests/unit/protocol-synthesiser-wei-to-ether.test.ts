import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearEncodeTransforms,
  registerEncodeTransform,
  weiToEther,
} from "@/lib/protocol-encode-transforms";
import { synthesiseProtocolTemplate } from "@/lib/workflow/codegen/protocol-synthesiser";

afterEach(() => {
  clearEncodeTransforms();
  vi.restoreAllMocks();
});

describe("synthesiser: weiToEther kind", () => {
  it("emits the payable value unconverted, which is wei on both sides", () => {
    // The only legal registration: weiToEther on the virtual ethValue
    // field. The emitted SDK passes `BigInt(input.ethValue)` and so reads
    // the field as wei; with the transform registered the runtime reads it
    // as wei too. This asserts the state as it is rather than as it ought
    // to be. The weiToEther branch in protocol-synthesiser.ts explains why
    // the two sides still disagree for every action *without* the
    // transform, and why reconciling them is a separate change.
    registerEncodeTransform(
      "chainlink",
      "ccip-send",
      "ethValue",
      weiToEther,
      "weiToEther"
    );

    const out = synthesiseProtocolTemplate("chainlink/ccip-send", {
      network: "11155111",
    });
    expect(out).not.toBeNull();
    expect(out as string).toContain("BigInt(input.ethValue)");
    expect(out as string).not.toContain("formatEther");
  });

  it("fails the export loudly if the kind ever reaches an ABI arg", async () => {
    // registerEncodeTransform refuses this registration, so the branch
    // cannot be reached by registering anything. Reaching it takes a
    // deliberate bypass of the lookup, which is exactly the scenario the
    // branch defends against: the guard removed, or a second instance of
    // the transforms module without it. What must not happen is a silent
    // passthrough emitting SDK source that converts nothing while the
    // runtime converts.
    vi.spyOn(
      await import("@/lib/protocol-encode-transforms"),
      "getEncodeTransformKind"
    ).mockReturnValue("weiToEther");

    expect(() =>
      synthesiseProtocolTemplate("chainlink/ccip-approve-bridge-token", {
        network: "11155111",
      })
    ).toThrow(/only valid on the virtual ethValue field/);
  });
});
