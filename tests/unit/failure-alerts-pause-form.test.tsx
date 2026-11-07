// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toLocalInput } from "@/components/failure-alerts/format";
import { PauseAlertsForm } from "@/components/failure-alerts/pause-alerts";

const DAY_MS = 24 * 60 * 60 * 1000;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <PauseAlertsForm
        disablingWorkflows={0}
        onCancel={() => undefined}
        onPause={async () => null}
      />
    )
  );
  const custom = container.querySelector<HTMLInputElement>(
    'input[type="radio"][value="custom"]'
  );
  act(() => custom?.click());
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function pick(value: string): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>(
    'input[type="datetime-local"]'
  );
  if (!input) {
    throw new Error("no time input");
  }
  // React tracks the value itself, so set it the way the browser does.
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value"
  )?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return input;
}

describe("pause form custom time", () => {
  it("moves a time past 7 days back to the latest allowed", () => {
    const input = pick(toLocalInput(new Date(Date.now() + 8 * DAY_MS)));

    const chosen = new Date(input.value).getTime();
    expect(chosen).toBeLessThanOrEqual(Date.now() + 7 * DAY_MS);
    expect(chosen).toBeGreaterThan(Date.now() + 7 * DAY_MS - 2 * 60 * 1000);
    expect(container.textContent).toContain(
      "Moved to the latest time allowed, 7 days from now."
    );
    expect(container.querySelector('[id$="-invalid"]')).toBeNull();
  });

  it("keeps a time inside the limit as picked", () => {
    const wanted = toLocalInput(new Date(Date.now() + 2 * DAY_MS));
    const input = pick(wanted);

    expect(input.value).toBe(wanted);
    expect(container.textContent).not.toContain("Moved to the latest");
  });
});
