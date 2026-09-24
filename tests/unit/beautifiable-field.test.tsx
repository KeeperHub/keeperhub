// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

import { BeautifiableField } from "@/components/workflow/config/beautifiable-field";
import { MAX_BEAUTIFY_BYTES } from "@/lib/utils/beautify";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

type Options = {
  language?: string;
  showAction?: boolean;
  disabled?: boolean;
};

function render({
  language = "json",
  showAction,
  disabled,
}: Options = {}): void {
  act(() => {
    root.render(
      <BeautifiableField
        disabled={disabled}
        language={language}
        onChange={() => {
          // not exercised here
        }}
        showAction={showAction}
        value='{"a":1}'
      >
        <textarea data-testid="input" readOnly value='{"a":1}' />
      </BeautifiableField>
    );
  });
}

function frame(): HTMLElement {
  const found = container.firstElementChild;
  if (!(found instanceof HTMLElement)) {
    throw new Error("no frame rendered");
  }
  return found;
}

describe("BeautifiableField", () => {
  it("frames the input and offers the action", () => {
    render();
    expect(container.querySelector("button")?.textContent).toContain(
      "Beautify"
    );
    expect(container.querySelector('[data-testid="input"]')).not.toBeNull();
  });

  it("keeps the frame but drops the action when showAction is false", () => {
    render({ showAction: false });
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector('[data-testid="input"]')).not.toBeNull();
    expect(frame().className).toContain("rounded-md");
    expect(frame().className).toContain("border");
  });

  it("drops the action for a language with no formatter", () => {
    render({ language: "sql" });
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector('[data-testid="input"]')).not.toBeNull();
  });

  // The frame owns the border, so it has to own the states the border carries.
  // `overflow-hidden` clips a ring drawn on the input, and the input's own
  // dimming stopped reaching the border once the border moved out here.
  it("carries the focus ring itself, since it clips one drawn inside", () => {
    render();
    expect(frame().className).toContain("overflow-hidden");
    expect(frame().className).toContain(
      "has-[[data-beautify-input]:focus-within]:ring-1"
    );
    expect(frame().className).toContain(
      "has-[[data-beautify-input]:focus-within]:ring-ring"
    );
  });

  // The button sits inside the frame, so a plain focus-within would ring the
  // whole field when the button takes focus, as though the editor had it.
  it("keys the ring off the input rather than any descendant", () => {
    render();
    const marked = container.querySelector("[data-beautify-input]");
    expect(marked).not.toBeNull();
    expect(marked?.querySelector('[data-testid="input"]')).not.toBeNull();
    expect(marked?.querySelector("button")).toBeNull();
    expect(frame().className).not.toMatch(/(^|\s)focus-within:ring-1/);
  });

  it("dims itself when disabled", () => {
    render({ disabled: true });
    expect(frame().className).toContain("opacity-50");
  });

  it("is not dimmed when enabled", () => {
    render();
    expect(frame().className).not.toContain("opacity-50");
  });

  it("disables the action when the field is disabled", () => {
    render({ disabled: true });
    const button = container.querySelector("button");
    expect(button?.hasAttribute("disabled")).toBe(true);
  });
});

// Formatting inflates a value about 1.7x and the import route caps a payload
// at 1 MB, so a large enough field can be formatted into a workflow that will
// not import - and nothing puts it back. The control stays visible and says
// why rather than disappearing.
describe("BeautifiableField above the size budget", () => {
  function renderLarge(): void {
    const huge = `{"a":"${"x".repeat(MAX_BEAUTIFY_BYTES)}"}`;
    act(() => {
      root.render(
        <BeautifiableField
          language="json"
          onChange={() => {
            // not exercised here
          }}
          value={huge}
        >
          <textarea data-testid="input" readOnly value={huge} />
        </BeautifiableField>
      );
    });
  }

  it("greys the action out rather than hiding it", () => {
    renderLarge();
    const button = container.querySelector("button");
    expect(button).not.toBeNull();
    expect(button?.hasAttribute("disabled")).toBe(true);
  });

  it("keeps the field usable", () => {
    renderLarge();
    expect(container.querySelector('[data-testid="input"]')).not.toBeNull();
    expect(frame().className).not.toContain("opacity-50");
  });
});
