// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/workflow/store", async () => {
  const { atom } = await import("jotai");
  return {
    nodesAtom: atom([]),
    selectedNodeAtom: atom(null),
  };
});
vi.mock("@/components/ui/template-autocomplete", () => ({
  TemplateAutocomplete: () => null,
}));
vi.mock("@/components/workflow/config/tuple-input-field", () => ({
  TupleInputField: () => null,
}));

import "@/lib/workflow/editor/extensions";
import { getCustomFieldRenderer } from "@/lib/workflow/editor/extension-registry";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
});

describe("registered protocol-array renderer", () => {
  it.each(["100", "true", "1000000000000000000000"])(
    "preserves legacy scalar %s when adding an item",
    async (legacyValue) => {
      const renderer = getCustomFieldRenderer("protocol-array");
      const onUpdateConfig = vi.fn();

      expect(renderer).toBeDefined();
      await act(async () =>
        root.render(
          renderer?.({
            config: { requestIds: legacyValue },
            field: {
              key: "requestIds",
              label: "Request IDs",
              solidityType: "uint256[]",
              type: "protocol-array",
            },
            onUpdateConfig,
          })
        )
      );

      expect(container.textContent).not.toContain("Empty array");
      expect(container.querySelector('[role="textbox"]')?.textContent).toBe(
        legacyValue
      );
      expect(onUpdateConfig).not.toHaveBeenCalled();

      const addButton = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent?.includes("Add Item")
      );
      expect(addButton).toBeDefined();
      await act(async () => addButton?.click());

      expect(onUpdateConfig).toHaveBeenCalledWith(
        "requestIds",
        JSON.stringify([legacyValue, ""])
      );
    }
  );

  it("shows and preserves a legacy JSON object as raw text", async () => {
    const renderer = getCustomFieldRenderer("protocol-array");
    const onUpdateConfig = vi.fn();
    const legacyValue = '{"amount":"1"}';

    expect(renderer).toBeDefined();
    await act(async () =>
      root.render(
        renderer?.({
          config: { requestIds: legacyValue },
          field: {
            key: "requestIds",
            label: "Request IDs",
            solidityType: "uint256[]",
            type: "protocol-array",
          },
          onUpdateConfig,
        })
      )
    );

    expect(container.querySelector('[role="textbox"]')?.textContent).toBe(
      legacyValue
    );
    expect(onUpdateConfig).not.toHaveBeenCalled();

    const addButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Add Item")
    );
    expect(addButton).toBeDefined();
    await act(async () => addButton?.click());

    expect(onUpdateConfig).toHaveBeenCalledWith(
      "requestIds",
      JSON.stringify([legacyValue, ""])
    );
  });
});
