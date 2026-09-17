// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/api-client", () => ({ api: { workflow: { update: vi.fn() } } }));
vi.mock("@/components/address-book/save-address-bookmark", () => ({
  SaveAddressBookmark: () => null,
}));
vi.mock("@/components/ui/template-badge-input", () => ({
  TemplateBadgeInput: ({ value, id }: { value: string; id: string }) => (
    <input id={id} readOnly value={value} />
  ),
}));
vi.mock("@/components/ui/template-badge-textarea", () => ({
  TemplateBadgeTextarea: () => null,
}));
vi.mock("@/components/workflow/config/schema-builder", () => ({
  SchemaBuilder: () => null,
}));

import { TriggerConfig } from "@/components/workflow/config/trigger-config";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response("[]", { status: 200 })))
  );
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function renderTrace(disabled: boolean): ReturnType<typeof vi.fn> {
  const onUpdateConfig = vi.fn();
  act(() => {
    root.render(
      <TriggerConfig
        config={{ triggerType: "Trace", network: "9745" }}
        disabled={disabled}
        onUpdateConfig={onUpdateConfig}
      />
    );
  });
  return onUpdateConfig;
}

describe("Trace trigger panel", () => {
  it("persists the default call outcome for an editor", () => {
    const onUpdateConfig = renderTrace(false);
    expect(onUpdateConfig).toHaveBeenCalledWith("traceStatus", "success");
  });

  it("writes nothing when opened read-only", () => {
    // A viewer who cannot edit would otherwise dirty the canvas and fire an
    // autosave the server refuses.
    const onUpdateConfig = renderTrace(true);
    expect(onUpdateConfig).not.toHaveBeenCalled();
  });
});
