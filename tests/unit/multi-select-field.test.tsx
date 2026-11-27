// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import "@/lib/workflow/editor/extensions";
import { getCustomFieldRenderer } from "@/lib/workflow/editor/extension-registry";
import type { ActionConfigFieldBase } from "@/plugins/registry";

const FIELD = {
  key: "colors",
  label: "Colors",
  type: "multi-select",
  max: 8,
  options: [
    { label: "Red", value: "red" },
    { label: "Blue", value: "blue" },
  ],
} as ActionConfigFieldBase;

let container: HTMLDivElement;
let root: Root;
let latest: Record<string, unknown> = {};

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
  document.body.innerHTML = "";
});

function Harness({ initial }: { initial: Record<string, unknown> }) {
  const [config, setConfig] = useState(initial);
  latest = config;
  const render = getCustomFieldRenderer("multi-select");
  return (
    <>
      {render?.({
        field: FIELD,
        config,
        onUpdateConfig: (key, value) =>
          setConfig((current) => ({ ...current, [key]: value })),
      })}
    </>
  );
}

async function show(initial: Record<string, unknown>): Promise<void> {
  await act(async () => {
    root.render(<Harness initial={initial} />);
    await Promise.resolve();
  });
}

function byTestId(id: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${id}"]`);
}

describe("the multi-select field type's renderer", () => {
  it("lists the field's options under generic test ids and stores the picked values", async () => {
    await show({});
    expect(container.textContent).toContain(
      "All 2 options, including new ones"
    );
    await act(async () => {
      container.querySelector<HTMLButtonElement>("button")?.click();
      await Promise.resolve();
    });
    const list = byTestId("multi-select-list");
    expect(list).not.toBeNull();
    expect(byTestId("bundle-builders-list")).toBeNull();
    const box = [...(list?.querySelectorAll('[role="checkbox"]') ?? [])].find(
      (candidate) => candidate.parentElement?.textContent?.trim() === "Blue"
    ) as HTMLButtonElement | undefined;
    await act(async () => {
      box?.click();
      await Promise.resolve();
    });
    expect(latest.colors).toEqual(["red"]);
  });

  it("marks a stored value the options no longer list", async () => {
    await show({ colors: ["red", "green"] });
    expect(container.textContent).toContain("No longer an option: green.");
  });
});
