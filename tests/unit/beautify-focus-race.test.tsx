// @vitest-environment jsdom
//
// Formatting writes the new text to the config, but the badge editor only
// takes an outside value while it is unfocused, and its blur handler holds
// "focused" true for 200 ms. Clicking Beautify blurs the field, so the value
// lands during that window - and if focus returns to the field before the
// window closes, the blur timeout early-returns and "focused" never goes
// false. Nothing re-runs the sync effect after that: the field keeps showing
// the old text, and the next keystroke serialises that stale DOM back over
// the formatted value.

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

import { TemplateBadgeTextarea } from "@/components/ui/template-badge-textarea";
import { BeautifiableField } from "@/components/workflow/config/beautifiable-field";
import { beautifyJson } from "@/lib/utils/beautify";

const MINIFIED = '{"a":1,"b":[2,3],"c":{"d":true}}';

function formatted(): string {
  const outcome = beautifyJson(MINIFIED);
  if (!outcome.ok) {
    throw new Error(`fixture did not format: ${outcome.error}`);
  }
  return outcome.value;
}

function Field(): React.ReactElement {
  const [value, setValue] = useState(MINIFIED);
  return (
    <BeautifiableField language="json" onChange={setValue} value={value}>
      <TemplateBadgeTextarea onChange={setValue} value={value} />
    </BeautifiableField>
  );
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<Field />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

function editable(): HTMLElement {
  const found = container.querySelector<HTMLElement>(
    '[contenteditable="true"]'
  );
  if (!found) {
    throw new Error("no editable rendered");
  }
  return found;
}

function beautifyButton(): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>("button");
  if (!found) {
    throw new Error("no beautify button rendered");
  }
  return found;
}

/** Line breaks the field is actually showing, as <br> elements. */
function renderedLineBreaks(): number {
  return container.querySelectorAll("br").length;
}

async function clickBeautify(): Promise<void> {
  const button = beautifyButton();
  await act(async () => {
    // Mousedown moves focus to the button, which blurs the editor.
    button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    button.focus();
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
}

describe("beautifying a focused badge field", () => {
  it("shows the formatted text once the field settles", async () => {
    act(() => editable().focus());
    await clickBeautify();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(renderedLineBreaks()).toBe(formatted().split("\n").length - 1);
  });

  // The regression: clicking back into the field before the blur window
  // closes used to leave the pre-format text on screen for good.
  it("shows it too when focus returns before the blur window closes", async () => {
    act(() => editable().focus());
    await clickBeautify();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
      editable().focus();
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(renderedLineBreaks()).toBe(formatted().split("\n").length - 1);
  });

  it("works from an unfocused field as well", async () => {
    await clickBeautify();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(renderedLineBreaks()).toBe(formatted().split("\n").length - 1);
  });
});
