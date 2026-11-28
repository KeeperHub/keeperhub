// @vitest-environment jsdom
import { ReactFlowProvider } from "@xyflow/react";
import { createStore, Provider } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
// The add-step button needs the editor's overlays; this test is about the pill.
vi.mock("@/components/workflow/add-step-button", () => ({
  AddStepButton: () => null,
}));

import { ActionNode } from "@/components/workflow/nodes/action-node";
import { WAITING_STEP_TEXT } from "@/lib/workflow/executor/run-outcome-keys";
import {
  canvasNodeStatus,
  executionLogsAtom,
  type NodeRunStatus,
  selectedExecutionIdAtom,
} from "@/lib/workflow/store";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderNode(status: NodeRunStatus, output?: unknown): void {
  const store = createStore();
  if (output !== undefined) {
    store.set(selectedExecutionIdAtom, "run-1");
    store.set(executionLogsAtom, {
      keeper: {
        nodeId: "keeper",
        nodeName: "Keeper call",
        nodeType: "web3/write-contract",
        status: "success",
        output,
      },
    });
  }
  const props = {
    id: "keeper",
    selected: false,
    data: {
      type: "action",
      label: "Keeper call",
      status,
      config: { actionType: "web3/write-contract", sendMode: "bundle" },
    },
  } as unknown as Parameters<typeof ActionNode>[0];
  act(() => {
    root.render(
      <Provider store={store}>
        <ReactFlowProvider>
          <ActionNode {...props} />
        </ReactFlowProvider>
      </Provider>
    );
  });
}

describe("the Waiting pill on the canvas node", () => {
  it("is the canvas state of a step that waited for Not before", () => {
    expect(canvasNodeStatus({ status: "success", outcome: "waiting" })).toBe(
      "waiting"
    );
  });

  it("shows Waiting with the shared sentence, on a dashed neutral border", () => {
    renderNode("waiting");
    const pill = container.querySelector('[data-testid="node-waiting"]');
    expect(pill?.textContent).toBe(WAITING_STEP_TEXT.label);
    expect(pill?.getAttribute("title")).toBe(
      `Waiting: ${WAITING_STEP_TEXT.sentence}`
    );
    expect(pill?.className).toContain("bg-muted");
    expect(pill?.querySelector("svg")?.getAttribute("aria-hidden")).toBe(
      "true"
    );
    const node = container.querySelector('[data-testid="action-node-keeper"]');
    expect(node?.className).toContain("border-dashed");
    expect(node?.className).not.toContain("border-green-500");
  });

  it("says Max Fee held the step back when every target ahead was skipped for it", () => {
    renderNode("waiting", {
      success: true,
      route: "waiting",
      included: false,
      bundleTargetsSkipped: [
        { block: 1004, reason: "max-fee-below-projected-base-fee" },
      ],
    });
    const pill = container.querySelector('[data-testid="node-waiting"]');
    expect(pill?.getAttribute("title")).toBe(
      "Waiting: Max Fee held back the targets ahead, so this step sent nothing (no gas was paid); raise Max Fee if it keeps waiting."
    );
  });

  it("keeps the other outcome pills", () => {
    renderNode("not-included");
    expect(
      container.querySelector('[data-testid="node-not-included"]')?.textContent
    ).toBe("Not included");
    expect(container.querySelector('[data-testid="node-waiting"]')).toBeNull();
  });
});
