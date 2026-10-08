// @vitest-environment jsdom
//
// The full-screen dialog swaps one live input for another: the field's own
// editor unmounts as the dialog's mounts, and the reverse on close. The badge
// editor only takes an outside value while unfocused and holds "focused" for
// 200 ms after a blur, so these pin that edits cross the swap in both
// directions, and that Beautify clicked in the dialog header reaches the
// dialog's editor.

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

import { TemplateBadgeTextarea } from "@/components/ui/template-badge-textarea";
import {
  BeautifiableField,
  type FieldSize,
} from "@/components/workflow/config/beautifiable-field";
import { beautifyJson } from "@/lib/utils/beautify";

const MINIFIED = '{"a":1,"b":[2,3]}';

function formatted(): string {
  const outcome = beautifyJson(MINIFIED);
  if (!outcome.ok) {
    throw new Error(`fixture did not format: ${outcome.error}`);
  }
  return outcome.value;
}

let stored = "";

function Field(): React.ReactElement {
  const [value, setValue] = useState(MINIFIED);
  stored = value;
  return (
    <BeautifiableField
      label="Payload"
      language="json"
      onChange={setValue}
      value={value}
    >
      {(size: FieldSize) => (
        <TemplateBadgeTextarea
          fill={size === "fill"}
          onChange={setValue}
          value={value}
        />
      )}
    </BeautifiableField>
  );
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  // Radix measures a tooltip's trigger with an observer jsdom does not have.
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
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<Field />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function button(name: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find(
    (b) => b.getAttribute("aria-label") === name || b.textContent === name
  );
  if (!found) {
    throw new Error(`no button named ${name}`);
  }
  return found;
}

function editableIn(scope: ParentNode): HTMLElement {
  const found = scope.querySelector<HTMLElement>('[contenteditable="true"]');
  if (!found) {
    throw new Error("no editable rendered");
  }
  return found;
}

function dialog(): HTMLElement {
  const found = document.querySelector<HTMLElement>('[role="dialog"]');
  if (!found) {
    throw new Error("no dialog open");
  }
  return found;
}

function type(editable: HTMLElement, text: string): void {
  act(() => {
    editable.textContent = text;
    editable.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function settle(): void {
  act(() => {
    vi.advanceTimersByTime(300);
  });
}

describe("full-screen editing", () => {
  it("opens with the field's latest value, even while the field has focus", () => {
    const panel = editableIn(container);
    act(() => panel.focus());
    type(panel, '{"edited":true}');

    act(() => button("Open in full screen").click());
    settle();
    expect(editableIn(dialog()).textContent).toBe('{"edited":true}');
  });

  it("keeps an edit made in the dialog after it closes", () => {
    act(() => button("Open in full screen").click());
    type(editableIn(dialog()), '{"fromDialog":1}');
    expect(stored).toBe('{"fromDialog":1}');

    act(() => button("Exit full screen").click());
    settle();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(editableIn(container).textContent).toBe('{"fromDialog":1}');
  });

  it("shows Beautify's result in the dialog's editor", async () => {
    act(() => button("Open in full screen").click());
    const beautify = [...dialog().querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Beautify")
    );
    await act(async () => {
      // A real click: mousedown moves focus to the button, blurring the editor.
      beautify?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      beautify?.focus();
      beautify?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(300);
    });
    settle();

    expect(stored).toBe(formatted());
    expect(dialog().querySelectorAll("br").length).toBe(
      formatted().split("\n").length - 1
    );
  });
});
