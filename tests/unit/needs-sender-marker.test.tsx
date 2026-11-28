import { ReactFlowProvider } from "@xyflow/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OverlayProvider } from "@/components/overlays/overlay-provider";
import { Web3ConnectionSelect } from "@/components/workflow/config/web3-connection-select";
import { ActionNode } from "@/components/workflow/nodes/action-node";
import { SENDER_NOT_CHOSEN } from "@/lib/safe/sender-not-chosen";

function renderStep(
  web3Connection: string,
  actionType = "web3/transfer-funds"
): string {
  const props = {
    id: "swap-1",
    selected: false,
    data: {
      label: "Swap USDC",
      type: "action",
      config: {
        actionType,
        network: "1",
        web3Connection,
      },
    },
  } as unknown as Parameters<typeof ActionNode>[0];
  return renderToStaticMarkup(
    <OverlayProvider>
      <ReactFlowProvider>
        <ActionNode {...props} />
      </ReactFlowProvider>
    </OverlayProvider>
  );
}

function renderPicker(value: string): string {
  return renderToStaticMarkup(
    <Web3ConnectionSelect
      network="1"
      onChange={() => undefined}
      value={value}
    />
  );
}

describe("a copied step that needs a sender", () => {
  it("is marked on the canvas until a sender is picked", () => {
    const marked = renderStep(SENDER_NOT_CHOSEN);
    expect(marked).toContain('data-testid="step-needs-sender"');
    expect(marked).toContain('<span class="sr-only">Pick a sender</span>');
    // Its own icon, not the missing-connection triangle.
    expect(marked).toContain("lucide-wallet");
    expect(marked).not.toContain("lucide-triangle-alert");

    for (const picked of ["default", "eoa", "safe:own-safe"]) {
      expect(renderStep(picked)).not.toContain("step-needs-sender");
    }
  });

  it("is not marked on a step whose action never reads its Web3 Connection", () => {
    for (const actionType of ["aave-v3/supply", "web3/sign-typed-data"]) {
      expect(renderStep(SENDER_NOT_CHOSEN, actionType)).not.toContain(
        "step-needs-sender"
      );
    }
  });

  it("shows the field error in its Web3 Connection picker until one is picked", () => {
    const waiting = renderPicker(SENDER_NOT_CHOSEN);
    expect(waiting).toContain('aria-invalid="true"');
    expect(waiting).toContain("Pick a sender");
    expect(waiting).toContain('id="web3Connection-error"');
    // The marker value is never offered as a stale Safe option.
    expect(waiting).not.toContain("Unavailable");

    const picked = renderPicker("eoa");
    expect(picked).not.toContain('aria-invalid="true"');
    expect(picked).not.toContain("web3Connection-error");
  });
});
