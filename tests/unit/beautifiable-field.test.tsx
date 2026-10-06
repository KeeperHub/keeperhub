// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

import {
  BeautifiableField,
  type FieldSize,
  tallFieldHeight,
} from "@/components/workflow/config/beautifiable-field";
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

  // The strip is left undimmed so the expand buttons stay usable on a
  // read-only field; Beautify greys itself out.
  it("dims its border and input when disabled", () => {
    render({ disabled: true });
    expect(frame().className).toContain("border-border/50");
    expect(
      container.querySelector("[data-beautify-input]")?.className
    ).toContain("opacity-50");
  });

  it("is not dimmed when enabled", () => {
    render();
    expect(frame().className).not.toContain("border-border/50");
    expect(
      container.querySelector("[data-beautify-input]")?.className
    ).not.toContain("opacity-50");
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

// A field whose input is given as a function of its size gets two more
// buttons: one makes it taller in place, one opens it in a full-screen dialog.
describe("BeautifiableField expand controls", () => {
  type SizedOptions = Options & { label?: string };

  function renderSized({
    language = "json",
    showAction,
    disabled,
    label = "Body (JSON)",
  }: SizedOptions = {}): void {
    act(() => {
      root.render(
        <BeautifiableField
          disabled={disabled}
          label={label}
          language={language}
          onChange={() => {
            // not exercised here
          }}
          showAction={showAction}
          value='{"a":1}'
        >
          {(size: FieldSize) => (
            <textarea
              data-size={size}
              data-testid="input"
              readOnly
              value='{"a":1}'
            />
          )}
        </BeautifiableField>
      );
    });
  }

  function button(name: string): HTMLButtonElement {
    const found = document.querySelector(`button[aria-label="${name}"]`);
    if (!(found instanceof HTMLButtonElement)) {
      throw new Error(`no button labelled ${name}`);
    }
    return found;
  }

  function inputSizes(): (string | null)[] {
    return [...document.querySelectorAll('[data-testid="input"]')].map(
      (input) => input.getAttribute("data-size")
    );
  }

  function pressEscape(): void {
    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        })
      );
    });
  }

  beforeEach(() => {
    // The dialog focuses its exit button, which opens that button's tooltip,
    // and the tooltip measures itself with an observer jsdom does not have.
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe(): void {
          // jsdom does no layout
        }
        unobserve(): void {
          // jsdom does no layout
        }
        disconnect(): void {
          // jsdom does no layout
        }
      }
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("offers Make taller and Open in full screen beside Beautify", () => {
    renderSized();
    expect(container.textContent).toContain("Beautify");
    expect(button("Make taller").getAttribute("aria-pressed")).toBe("false");
    expect(button("Open in full screen")).not.toBeNull();
    expect(inputSizes()).toEqual(["normal"]);
  });

  it("does not offer them for an input given as a node", () => {
    render();
    expect(
      container.querySelector('button[aria-label="Make taller"]')
    ).toBeNull();
    expect(
      container.querySelector('button[aria-label="Open in full screen"]')
    ).toBeNull();
  });

  it("toggles the input between normal and tall", () => {
    renderSized();
    act(() => button("Make taller").click());
    expect(inputSizes()).toEqual(["tall"]);
    const pressed = button("Back to normal height");
    expect(pressed.getAttribute("aria-pressed")).toBe("true");

    act(() => pressed.click());
    expect(inputSizes()).toEqual(["normal"]);
    expect(button("Make taller").getAttribute("aria-pressed")).toBe("false");
  });

  // SQL has no formatter, so the strip used to be dropped there entirely.
  it("keeps the strip for the expand buttons on a field with no formatter", () => {
    renderSized({ language: "sql" });
    expect(container.textContent).not.toContain("Beautify");
    expect(button("Make taller")).not.toBeNull();
    expect(button("Open in full screen")).not.toBeNull();
  });

  it("keeps the expand buttons when the beautify action is hidden", () => {
    renderSized({ showAction: false });
    expect(container.textContent).not.toContain("Beautify");
    expect(button("Make taller")).not.toBeNull();
  });

  // Reading a long value is the point, so read-only does not take them away.
  it("leaves the expand buttons usable on a disabled field", () => {
    renderSized({ disabled: true });
    const beautify = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Beautify")
    );
    expect(beautify?.hasAttribute("disabled")).toBe(true);
    expect(button("Make taller").hasAttribute("disabled")).toBe(false);
    expect(button("Open in full screen").hasAttribute("disabled")).toBe(false);
  });

  it("opens the input alone in a full-screen dialog", () => {
    renderSized();
    act(() => button("Open in full screen").click());

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain("Body (JSON)");
    // One live input: the dialog's. The field holds its place meanwhile.
    expect(inputSizes()).toEqual(["fill"]);
    expect(container.textContent).toContain("Editing in full screen");
  });

  it("closes the dialog with Escape and returns the input to the field", () => {
    renderSized();
    act(() => button("Open in full screen").click());
    pressEscape();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(inputSizes()).toEqual(["normal"]);
  });

  it("closes the dialog with its exit button", () => {
    renderSized();
    act(() => button("Open in full screen").click());
    act(() => button("Exit full screen").click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("returns to the height the field had before it opened", () => {
    renderSized();
    act(() => button("Make taller").click());
    act(() => button("Open in full screen").click());
    act(() => button("Exit full screen").click());
    expect(inputSizes()).toEqual(["tall"]);
  });

  // Escape closes an open variable picker first, not the dialog under it.
  it("keeps the dialog open on Escape while a variable picker is open", () => {
    renderSized();
    act(() => button("Open in full screen").click());
    const picker = document.createElement("div");
    picker.setAttribute("data-template-autocomplete", "");
    document.querySelector('[role="dialog"]')?.appendChild(picker);

    pressEscape();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("falls back to a generic title when the field has no label", () => {
    renderSized({ label: "" });
    act(() => button("Open in full screen").click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "Edit field"
    );
  });
});

describe("tallFieldHeight", () => {
  it("fits content between the normal height and the cap", () => {
    expect(
      tallFieldHeight({ normalHeight: 120, contentHeight: 396, maxHeight: 480 })
    ).toBe(396);
  });

  it("stops at the cap", () => {
    expect(
      tallFieldHeight({
        normalHeight: 120,
        contentHeight: 1400,
        maxHeight: 480,
      })
    ).toBe(480);
  });

  it("never goes below the normal height", () => {
    expect(
      tallFieldHeight({ normalHeight: 320, contentHeight: 60, maxHeight: 480 })
    ).toBe(320);
  });
});
