// @vitest-environment jsdom
import { act, useState } from "react";
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

import { ArrayInputField } from "@/components/workflow/config/array-input-field";

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

describe("ArrayInputField legacy migration", () => {
  it("writes a reopened comma-separated value back as a valid array", async () => {
    const onChange = vi.fn();

    await act(async () =>
      root.render(
        <ArrayInputField
          fieldKey="pools"
          itemType="address"
          onChange={onChange}
          value="0xpool1, 0xpool2"
        />
      )
    );

    expect(
      Array.from(
        container.querySelectorAll('[role="textbox"]'),
        (input) => input.textContent
      )
    ).toEqual(["0xpool1", "0xpool2"]);
    expect(onChange).toHaveBeenCalledWith(["0xpool1", "0xpool2"]);
  });

  it("does not rewrite a legacy value while disabled", async () => {
    const onChange = vi.fn();

    await act(async () =>
      root.render(
        <ArrayInputField
          disabled
          fieldKey="pools"
          itemType="address"
          onChange={onChange}
          value="0xpool1"
        />
      )
    );

    expect(
      Array.from(
        container.querySelectorAll('[role="textbox"]'),
        (input) => input.textContent
      )
    ).toEqual(["0xpool1"]);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not rewrite a single legacy value on an enabled look-only visit", async () => {
    const onChange = vi.fn();

    await act(async () =>
      root.render(
        <ArrayInputField
          fieldKey="pools"
          itemType="address"
          onChange={onChange}
          value="0xpool1"
        />
      )
    );

    expect(container.querySelector('[role="textbox"]')?.textContent).toBe(
      "0xpool1"
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not overwrite an empty comma-only legacy value", async () => {
    const onChange = vi.fn();

    await act(async () =>
      root.render(
        <ArrayInputField
          fieldKey="pools"
          itemType="address"
          onChange={onChange}
          value=","
        />
      )
    );

    expect(container.textContent).toContain("Empty array");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps displayed rows aligned when the legacy value changes", async () => {
    const onChange = vi.fn();

    await act(async () =>
      root.render(
        <ArrayInputField
          fieldKey="pools"
          itemType="address"
          onChange={onChange}
          value="0xpool1"
        />
      )
    );
    await act(async () =>
      root.render(
        <ArrayInputField
          fieldKey="pools"
          itemType="address"
          onChange={onChange}
          value="0xpool2, 0xpool3"
        />
      )
    );

    expect(
      Array.from(
        container.querySelectorAll('[role="textbox"]'),
        (input) => input.textContent
      )
    ).toEqual(["0xpool2", "0xpool3"]);
    expect(onChange).toHaveBeenLastCalledWith(["0xpool2", "0xpool3"]);
  });

  it("shows a whole-field template as an editable row", async () => {
    const onChange = vi.fn();

    await act(async () =>
      root.render(
        <ArrayInputField
          fieldKey="amounts"
          itemType="uint256"
          onChange={onChange}
          value="{{Get Withdrawal Requests.requestIds}}"
        />
      )
    );

    expect(container.textContent).not.toContain("Empty array");
    expect(container.querySelector('[role="textbox"]')?.textContent).toContain(
      "Get Withdrawal Requests.requestIds"
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it("preserves the focused row while a controlled parent accepts typing", async () => {
    function Harness(): React.ReactNode {
      const [value, setValue] = useState<unknown[]>(["0xpool1"]);
      return (
        <ArrayInputField
          fieldKey="pools"
          itemType="address"
          onChange={setValue}
          value={value}
        />
      );
    }

    await act(async () => root.render(<Harness />));
    const editor = container.querySelector<HTMLElement>('[role="textbox"]');
    expect(editor).not.toBeNull();
    editor?.focus();

    await act(async () => {
      if (!editor) {
        return;
      }
      editor.textContent = "0xpool12";
      editor.dispatchEvent(new InputEvent("input", { bubbles: true }));
    });

    expect(container.querySelector('[role="textbox"]')).toBe(editor);
    expect(document.activeElement).toBe(editor);
  });

  it("adds and removes rows through the real controls", async () => {
    function Harness(): React.ReactNode {
      const [value, setValue] = useState<unknown[]>(["0xpool1"]);
      return (
        <ArrayInputField
          fieldKey="pools"
          itemType="address"
          onChange={setValue}
          value={value}
        />
      );
    }

    await act(async () => root.render(<Harness />));
    const addButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Add Item")
    );
    expect(addButton).toBeDefined();

    await act(async () => addButton?.click());
    expect(container.querySelectorAll('[role="textbox"]')).toHaveLength(2);

    const removeButton = Array.from(container.querySelectorAll("button")).find(
      (button) => !button.textContent?.includes("Add Item")
    );
    expect(removeButton).toBeDefined();
    await act(async () => removeButton?.click());

    expect(container.querySelectorAll('[role="textbox"]')).toHaveLength(1);
  });
});
