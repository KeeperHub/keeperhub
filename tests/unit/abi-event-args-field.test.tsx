// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AbiEventArgsField } from "@/components/workflow/config/abi-event-args-field";
import type { ActionConfigFieldBase } from "@/plugins/registry";

const ALICE = "0x1111111111111111111111111111111111111111";

const ABI = JSON.stringify([
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
]);

const field: ActionConfigFieldBase = {
  key: "eventArgs",
  label: "Filter by Indexed Arguments",
  type: "abi-event-args",
};

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

function render(value: unknown, onChange = vi.fn(), disabled = false) {
  act(() => {
    root.render(
      <AbiEventArgsField
        abiValue={ABI}
        disabled={disabled}
        eventValue="Transfer"
        field={field}
        onChange={onChange}
        value={value}
      />
    );
  });
  return onChange;
}

function input(name: string): HTMLInputElement | null {
  return container.querySelector<HTMLInputElement>(`#eventArgs-${name}`);
}

describe("AbiEventArgsField", () => {
  it("shows a filter stored as an object, as an API caller stores it", () => {
    const onChange = render({ from: ALICE });
    expect(input("from")?.value).toBe(ALICE);
    expect(input("to")?.value).toBe("");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("says a stored value is unreadable instead of showing it as no filter", () => {
    for (const value of ["{not json", '["from"]', { from: { nested: 1 } }]) {
      render(value);
      expect(input("from"), JSON.stringify(value)).toBeNull();
      expect(container.textContent).toContain("cannot be shown here");
    }
  });

  it("clears an unreadable value on request", () => {
    const onChange = render("{not json");
    const button = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Clear filter"
    );
    act(() => button?.click());
    expect(onChange).toHaveBeenCalledWith("");
  });

  it("offers no clear button to a viewer who cannot edit", () => {
    render("{not json", vi.fn(), true);
    expect(container.querySelector("button")).toBeNull();
  });

  it("prunes a key the selected event does not have", () => {
    const onChange = render(JSON.stringify({ from: ALICE, owner: ALICE }));
    expect(onChange).toHaveBeenCalledWith(JSON.stringify({ from: ALICE }));
  });

  it("notes an unnamed indexed parameter beside the named ones", () => {
    const mixed = JSON.stringify([
      {
        type: "event",
        name: "Mixed",
        inputs: [
          { name: "", type: "address", indexed: true },
          { name: "to", type: "address", indexed: true },
        ],
      },
    ]);
    act(() => {
      root.render(
        <AbiEventArgsField
          abiValue={mixed}
          eventValue="Mixed"
          field={field}
          onChange={vi.fn()}
          value=""
        />
      );
    });
    expect(input("to")).not.toBeNull();
    expect(container.textContent).toContain(
      "also indexes 1 parameter(s) the ABI does not name"
    );
  });

  it("flags an unreadable filter even when the ABI has not loaded", () => {
    act(() => {
      root.render(
        <AbiEventArgsField
          abiValue=""
          eventValue="Transfer"
          field={field}
          onChange={vi.fn()}
          value="{not json"
        />
      );
    });
    expect(container.textContent).toContain("cannot be shown here");
  });

  it("flags a stored empty value instead of rendering it as no filter", () => {
    render({ from: "" });
    expect(input("from")?.value).toBe("");
    expect(input("from")?.getAttribute("aria-invalid")).toBe("true");
    expect(container.textContent).toContain("holds an empty value for from");
    // The parameter the user did not set carries none of this.
    expect(input("to")?.getAttribute("aria-invalid")).toBeNull();
  });

  it("removes the parameter when the empty row's button is used", () => {
    const onChange = render({ from: "", to: ALICE });
    const button = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Match any value"
    );
    act(() => button?.click());
    expect(onChange).toHaveBeenCalledWith(JSON.stringify({ to: ALICE }));
  });

  it("offers no way out of an empty row to a viewer who cannot edit", () => {
    render({ from: "" }, vi.fn(), true);
    expect(container.textContent).toContain("holds an empty value for from");
    expect(container.querySelector("button")).toBeNull();
  });

  it("keeps a whitespace-only filter on an indexed string, which hashes verbatim", () => {
    const tagged = JSON.stringify([
      {
        type: "event",
        name: "Tagged",
        inputs: [{ name: "label", type: "string", indexed: true }],
      },
    ]);
    const onChange = vi.fn();
    act(() => {
      root.render(
        <AbiEventArgsField
          abiValue={tagged}
          eventValue="Tagged"
          field={field}
          onChange={onChange}
          value=""
        />
      );
    });
    const box = container.querySelector<HTMLInputElement>("#eventArgs-label");
    expect(box).not.toBeNull();
    act(() => {
      // React tracks the last value it set, so assign through the prototype
      // setter to make the change event carry the new one.
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set;
      setter?.call(box, " ");
      box?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith(JSON.stringify({ label: " " }));
  });

  it("stores a filter for a parameter named __proto__ rather than losing it", () => {
    const proto = JSON.stringify([
      {
        type: "event",
        name: "Odd",
        inputs: [{ name: "__proto__", type: "address", indexed: true }],
      },
    ]);
    const onChange = vi.fn();
    act(() => {
      root.render(
        <AbiEventArgsField
          abiValue={proto}
          eventValue="Odd"
          field={field}
          onChange={onChange}
          value=""
        />
      );
    });
    const box = container.querySelector<HTMLInputElement>(
      "#eventArgs-__proto__"
    );
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set;
      setter?.call(box, ALICE);
      box?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // Written out rather than built with an object literal, where
    // `__proto__` would set the prototype and stringify to "{}".
    expect(onChange).toHaveBeenCalledWith(`{"__proto__":"${ALICE}"}`);
  });

  it("leaves the stored value alone when the panel is read-only", () => {
    const onChange = render(
      JSON.stringify({ from: ALICE, owner: ALICE }),
      vi.fn(),
      true
    );
    expect(onChange).not.toHaveBeenCalled();
  });
});
