import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActionRow } from "@/components/hub/protocol-detail";
import type { ProtocolAction } from "@/lib/protocol-registry";

function render(inputs: ProtocolAction["inputs"]): string {
  const action = {
    slug: "oft-send",
    label: "OFT Send",
    type: "write",
    description: "Send an OFT to another chain.",
    inputs,
  } as ProtocolAction;
  return renderToStaticMarkup(
    <ActionRow
      action={action}
      isCreating={false}
      isLast={false}
      onUse={() => undefined}
    />
  );
}

describe("hub action row inputs line", () => {
  it("leaves a payer input out of the listed inputs", () => {
    const html = render([
      { name: "nativeFee", type: "uint256", label: "Native Fee (wei)" },
      {
        name: "refundAddress",
        type: "address",
        label: "Refund Address",
        payer: true,
      },
    ]);

    expect(html).toContain("nativeFee (uint256)");
    expect(html).not.toContain("refundAddress");
  });

  it("reads as no inputs when every input is payer-owned", () => {
    const html = render([
      {
        name: "refundAddress",
        type: "address",
        label: "Refund Address",
        payer: true,
      },
    ]);

    expect(html).toContain("No inputs required");
    expect(html).not.toContain("Inputs:");
  });
});
