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

  it("shows numeric array elements instead of blank rows", async () => {
    const renderer = getCustomFieldRenderer("protocol-array");
    const onUpdateConfig = vi.fn();

    expect(renderer).toBeDefined();
    await act(async () =>
      root.render(
        renderer?.({
          config: { requestIds: "[135184]" },
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
      "135184"
    );
    expect(onUpdateConfig).not.toHaveBeenCalled();

    const addButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Add Item")
    );
    expect(addButton).toBeDefined();
    await act(async () => addButton?.click());

    expect(onUpdateConfig).toHaveBeenCalledWith(
      "requestIds",
      JSON.stringify(["135184", ""])
    );
  });
  it("splits a legacy comma-separated value into rows", async () => {
    const renderer = getCustomFieldRenderer("protocol-array");
    const onUpdateConfig = vi.fn();

    await act(async () =>
      root.render(
        renderer?.({
          config: { gauges: "0xpool1, 0xpool2" },
          field: {
            key: "gauges",
            label: "Gauge Addresses",
            solidityType: "address[]",
            type: "protocol-array",
          },
          onUpdateConfig,
        })
      )
    );

    expect(
      Array.from(
        container.querySelectorAll('[role="textbox"]'),
        (input) => input.textContent
      )
    ).toEqual(["0xpool1", "0xpool2"]);
    expect(onUpdateConfig).not.toHaveBeenCalled();
  });

  // One Lido action's array output feeds the next action's array input. A lone
  // reference is stored bare and resolves to the whole array; a second row
  // would splice the resolved array inside one quoted element, which cannot
  // encode, so the editor refuses it.
  it("refuses a second row beside a whole-field reference", async () => {
    const renderer = getCustomFieldRenderer("protocol-array");
    const onUpdateConfig = vi.fn();
    const reference = "{{@n1:Get Withdrawal Requests.requestsIds}}";
    const field = {
      key: "requestIds",
      label: "Request IDs",
      solidityType: "uint256[]",
      type: "protocol-array" as const,
    };

    await act(async () =>
      root.render(
        renderer?.({ config: { requestIds: reference }, field, onUpdateConfig })
      )
    );

    expect(container.querySelectorAll('[role="textbox"]')).toHaveLength(1);

    const addButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Add Item")
    ) as HTMLButtonElement | undefined;
    expect(addButton?.disabled).toBe(true);

    await act(async () => addButton?.click());
    expect(onUpdateConfig).not.toHaveBeenCalled();

    await act(async () =>
      root.render(
        renderer?.({
          config: { requestIds: JSON.stringify([reference, ""]) },
          field,
          onUpdateConfig,
        })
      )
    );

    const removeButtons = Array.from(
      container.querySelectorAll("button")
    ).filter((button) => !button.textContent?.includes("Add Item"));
    await act(async () => removeButtons.at(-1)?.click());

    expect(onUpdateConfig).toHaveBeenLastCalledWith("requestIds", reference);
  });
});

describe("registered protocol-tuple-array renderer", () => {
  it("shows a legacy stored object as one row", async () => {
    const renderer = getCustomFieldRenderer("protocol-tuple-array");
    const onUpdateConfig = vi.fn();

    expect(renderer).toBeDefined();
    await act(async () =>
      root.render(
        renderer?.({
          config: { tokenAmounts: '{"token":"0xA","amount":"1"}' },
          field: {
            key: "tokenAmounts",
            label: "Token Amounts",
            solidityType: "tuple[]",
            tupleComponents: [
              { name: "token", type: "address" },
              { name: "amount", type: "uint256" },
            ],
            type: "protocol-tuple-array",
          },
          onUpdateConfig,
        })
      )
    );

    expect(container.textContent).toContain("[0]");
    expect(container.textContent).not.toContain("Empty array");
    expect(onUpdateConfig).not.toHaveBeenCalled();
  });
});
