// @vitest-environment jsdom
import { createStore } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  ErrorCategory: {
    VALIDATION: "validation",
    WORKFLOW_ENGINE: "workflow_engine",
    UNKNOWN: "unknown",
  },
  logSystemError: vi.fn(),
  logUserError: vi.fn(),
}));
vi.mock("@/lib/workflow/editor/auto-layout", () => ({
  computeAutoLayout: vi.fn(),
}));
vi.mock("@/lib/workflow/editor/template-helpers", () => ({
  buildExecutionLogsMap: vi.fn(() => ({})),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/api-client", () => ({ api: { workflow: { update: vi.fn() } } }));
vi.mock("@/components/address-book/save-address-bookmark", () => ({
  SaveAddressBookmark: () => null,
}));
vi.mock("@/components/ui/template-badge-input", () => ({
  TemplateBadgeInput: ({ value, id }: { value: string; id: string }) => (
    <input id={id} readOnly value={value} />
  ),
}));
vi.mock("@/components/ui/template-badge-textarea", () => ({
  TemplateBadgeTextarea: () => null,
}));
vi.mock("@/components/workflow/config/schema-builder", () => ({
  SchemaBuilder: () => null,
}));

import { ActionConfigRenderer } from "@/components/workflow/config/action-config-renderer";
import { api } from "@/lib/api-client";
import {
  cancelPendingAutosave,
  currentWorkflowIdAtom,
  nodesAtom,
  updateNodeDataAtom,
} from "@/lib/workflow/store";
import type { ActionConfigField } from "@/plugins/registry";

const fields: ActionConfigField[] = [
  {
    key: "abiFunction",
    label: "Function",
    type: "abi-function-select",
    functionFilter: "write",
  },
  { key: "functionArgs", label: "Arguments", type: "abi-function-args" },
];
const tuple = {
  type: "function",
  name: "send",
  stateMutability: "nonpayable",
  inputs: [
    {
      name: "params",
      type: "tuple",
      components: [
        { name: "id", type: "uint32" },
        { name: "to", type: "bytes32" },
      ],
    },
    { name: "recipient", type: "address" },
  ],
};
const scalar = {
  type: "function",
  name: "send",
  stateMutability: "nonpayable",
  inputs: [{ name: "amount", type: "uint256" }],
};
const args = JSON.stringify([
  { id: "7", to: `0x${"11".repeat(32)}` },
  `0x${"22".repeat(20)}`,
]);
let container: HTMLDivElement;
let root: Root;
const onChange = vi.fn();
let store: ReturnType<typeof createStore>;

beforeEach(() => {
  vi.clearAllMocks();
  store = createStore();
  store.set(currentWorkflowIdAtom, "saved-legacy-workflow");
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  cancelPendingAutosave();
  vi.useRealTimers();
});
async function render(
  abi: unknown[],
  abiFunction: string,
  functionArgs = "[]"
) {
  const config = { abi: JSON.stringify(abi), abiFunction, functionArgs };
  store.set(nodesAtom, [
    {
      id: "write",
      type: "action",
      position: { x: 0, y: 0 },
      data: { type: "action", label: "Saved write", config },
    },
  ]);
  onChange.mockImplementation((key: string, value: unknown) => {
    store.set(updateNodeDataAtom, {
      id: "write",
      data: { config: { ...config, [key]: value } },
    });
  });
  await act(async () =>
    root.render(
      <ActionConfigRenderer
        config={config}
        fields={fields}
        onUpdateConfig={onChange}
      />
    )
  );
  return config;
}

describe("saved ABI function selection", () => {
  it("B1 keeps healthy functions beside a components-less tuple without inventing its selector", async () => {
    const healthy = Array.from({ length: 40 }, (_, index) => ({
      ...scalar,
      name: `good${index}`,
    }));
    await render(
      [
        ...healthy,
        { ...tuple, name: "broken", inputs: [{ name: "p", type: "tuple" }] },
      ],
      "good0"
    );
    expect(container.textContent).not.toContain("No functions found in ABI");
    expect(container.querySelector("[role=combobox]")?.textContent).toContain(
      "good0"
    );
    for (const entry of healthy) {
      await render(
        [
          ...healthy,
          { ...tuple, name: "broken", inputs: [{ name: "p", type: "tuple" }] },
        ],
        entry.name
      );
      expect(container.querySelector("[role=combobox]")?.textContent).toContain(
        `${entry.name}(`
      );
      expect(container.querySelector("[role=combobox] code")).not.toBeNull();
    }
    await render(
      [
        ...healthy,
        { ...tuple, name: "broken", inputs: [{ name: "p", type: "tuple" }] },
      ],
      "broken"
    );
    expect(container.querySelector("[role=combobox]")?.textContent).toContain(
      "broken"
    );
    expect(container.querySelector("[role=combobox] code")).toBeNull();
  });

  it("B3 displays an unambiguous saved legacy key with populated arguments and no writes", async () => {
    vi.useFakeTimers();
    const config = await render([tuple, scalar], "send(tuple,address)", args);
    await act(() => vi.advanceTimersByTimeAsync(3500));
    expect(store.get(nodesAtom)[0].data.config).toEqual(config);
    expect(
      container.querySelector("#functionArgs-0-id")?.getAttribute("value")
    ).toBe("7");
    expect(onChange).not.toHaveBeenCalled();
    expect(api.workflow.update).not.toHaveBeenCalled();
    expect(config.abiFunction).toBe("send(tuple,address)");
    // Positive control: the callback is wired to the real autosave atom.
    // A hidden normalization write would therefore be observable here.
    expect(container.querySelector("[role=combobox]")?.textContent).toContain(
      "send(tuple params, address recipient)"
    );
  });

  it("observes a workflow save when the same update callback is invoked", async () => {
    vi.useFakeTimers();
    vi.mocked(api.workflow.update).mockResolvedValue({} as never);
    await render([tuple, scalar], "send(tuple,address)", args);
    onChange("abiFunction", "send((uint32,bytes32),address)");
    await act(() => vi.advanceTimersByTimeAsync(3500));
    expect(api.workflow.update).toHaveBeenCalledTimes(1);
  });

  it("leaves an ambiguous legacy key unselected and does not write", async () => {
    const second = {
      ...tuple,
      inputs: [
        { ...tuple.inputs[0], components: [{ name: "other", type: "bytes" }] },
        tuple.inputs[1],
      ],
    };
    await render([tuple, second], "send(tuple,address)", args);
    expect(
      container.querySelector("[role=combobox]")?.textContent
    ).not.toContain("send(");
    expect(onChange).not.toHaveBeenCalled();
    expect(api.workflow.update).not.toHaveBeenCalled();
  });

  it("does not resolve ambiguity by hiding the read-only overload", async () => {
    const readOnly = {
      ...tuple,
      stateMutability: "view",
      inputs: [
        { ...tuple.inputs[0], components: [{ name: "other", type: "bytes" }] },
        tuple.inputs[1],
      ],
    };
    await render([tuple, readOnly], "send(tuple,address)", args);
    expect(
      container.querySelector("[role=combobox]")?.textContent
    ).not.toContain("send(");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("retains canonical and plain-name selections", async () => {
    await render([tuple, scalar], "send((uint32,bytes32),address)", args);
    expect(container.querySelector("[role=combobox]")?.textContent).toContain(
      "send(tuple params"
    );
    await render([tuple], "send", args);
    expect(container.querySelector("[role=combobox]")?.textContent).toContain(
      "send(tuple params"
    );
    expect(onChange).not.toHaveBeenCalled();
  });
});
