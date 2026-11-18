// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/workflow/store", async () => {
  const { atom } = await import("jotai");
  return { nodesAtom: atom([]), selectedNodeAtom: atom(null) };
});
vi.mock("@/components/ui/template-autocomplete", () => ({
  TemplateAutocomplete: () => null,
}));

import "@/lib/workflow/editor/extensions";
import { getCustomFieldRenderer } from "@/lib/workflow/editor/extension-registry";
import type { ActionConfigFieldBase } from "@/plugins/registry";

const FIELD: ActionConfigFieldBase = {
  key: "useAsCollateral",
  label: "Use As Collateral",
  type: "protocol-bool",
  defaultValue: "true",
};

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

async function renderWith(saved: unknown, disabled = false): Promise<void> {
  const renderer = getCustomFieldRenderer("protocol-bool");
  expect(renderer).toBeDefined();
  await act(async () =>
    root.render(
      renderer?.({
        config: { useAsCollateral: saved },
        disabled,
        field: FIELD,
        onUpdateConfig: vi.fn(),
      })
    )
  );
}

function trigger(): HTMLElement | null {
  return container.querySelector(`#${FIELD.key}`);
}

describe("registered protocol-bool renderer", () => {
  it("flags a saved 0 instead of showing the default", async () => {
    await renderWith(0);
    const message = container.querySelector(`#${FIELD.key}-unrecognized`);
    expect(message?.textContent).toBe(
      "Saved value 0 is not true or false. Select one to replace it."
    );
    expect(trigger()?.getAttribute("aria-invalid")).toBe("true");
    expect(trigger()?.getAttribute("aria-describedby")).toBe(message?.id);
    expect(trigger()?.textContent).toBe("Select true or false");
  });

  it("drops the message once true or false is saved", async () => {
    await renderWith(0);
    await renderWith("false");
    expect(container.querySelector(`#${FIELD.key}-unrecognized`)).toBeNull();
    expect(trigger()?.hasAttribute("aria-invalid")).toBe(false);
    expect(trigger()?.hasAttribute("aria-describedby")).toBe(false);
    expect(trigger()?.textContent).toBe("false");
  });

  // The cuts themselves are covered in protocol-bool-field.test.ts.
  it("shows the cut value and puts the longer one in a tooltip", async () => {
    const saved = "x".repeat(100);
    await renderWith(saved);
    const value = container.querySelector(`#${FIELD.key}-unrecognized bdi`);
    expect(value?.textContent).toBe(`"${"x".repeat(60)}"…`);
    expect(value?.getAttribute("title")).toBe(JSON.stringify(saved));
  });

  it("leaves a value shown whole without a tooltip", async () => {
    await renderWith("yes");
    expect(
      container
        .querySelector(`#${FIELD.key}-unrecognized bdi`)
        ?.hasAttribute("title")
    ).toBe(false);
  });

  it("does not ask a read-only viewer to pick", async () => {
    await renderWith("yes", true);
    expect(
      container.querySelector(`#${FIELD.key}-unrecognized`)?.textContent
    ).toBe('Saved value "yes" is not true or false.');
  });
});
