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

import {
  selectorForFunction,
  TriggerConfig,
} from "@/components/workflow/config/trigger-config";

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

function renderTrace(
  disabled: boolean,
  config: Record<string, unknown> = { triggerType: "Trace", network: "9745" }
): ReturnType<typeof vi.fn> {
  const onUpdateConfig = vi.fn();
  act(() => {
    root.render(
      <TriggerConfig
        config={config}
        disabled={disabled}
        onUpdateConfig={onUpdateConfig}
      />
    );
  });
  return onUpdateConfig;
}

function minValueBox(): HTMLInputElement | null {
  return container.querySelector<HTMLInputElement>("#traceMinValue");
}

describe("Trace trigger panel", () => {
  it("writes nothing on open, so opening the panel does not dirty the canvas", () => {
    // The default call outcome is applied by the events endpoint on the way
    // to the tracker, not persisted from here on first render.
    expect(renderTrace(false)).not.toHaveBeenCalled();
  });

  it("writes nothing when opened read-only", () => {
    // A viewer who cannot edit would otherwise dirty the canvas and fire an
    // autosave the server refuses.
    const onUpdateConfig = renderTrace(true);
    expect(onUpdateConfig).not.toHaveBeenCalled();
  });

  it("shows the wei threshold in force when only traceMinValueWei is set", () => {
    // An API or MCP author may send the wei value alone. The box has to show
    // the threshold that registers, not an empty field while it filters.
    renderTrace(false, {
      triggerType: "Trace",
      network: "9745",
      traceMinValueWei: "500000000000000000",
    });
    expect(minValueBox()?.value).toBe("0.5");
  });

  it("prefers the typed amount when both keys are set", () => {
    renderTrace(false, {
      triggerType: "Trace",
      network: "9745",
      traceMinValue: "0.50",
      traceMinValueWei: "500000000000000000",
    });
    expect(minValueBox()?.value).toBe("0.50");
  });
});

describe("selectorForFunction", () => {
  const PAUSABLE = JSON.stringify([
    {
      type: "function",
      name: "pause",
      inputs: [],
      stateMutability: "nonpayable",
    },
    {
      type: "function",
      name: "withdraw",
      inputs: [{ name: "amount", type: "uint256" }],
      stateMutability: "nonpayable",
    },
    {
      type: "function",
      name: "withdraw",
      inputs: [
        { name: "amount", type: "uint256" },
        { name: "to", type: "address" },
      ],
      stateMutability: "nonpayable",
    },
  ]);

  it("derives the selector the tracker matches on from the chosen function", () => {
    // keccak256("pause()")[:4] -- the example selector the panel itself shows.
    expect(selectorForFunction(PAUSABLE, "pause")).toBe("0x8456cb59");
  });

  it("resolves an overload by its qualified key", () => {
    // keccak256("withdraw(uint256)")[:4]
    expect(selectorForFunction(PAUSABLE, "withdraw(uint256)")).toBe(
      "0x2e1a7d4d"
    );
  });

  it("fills nothing in when the choice is ambiguous or unreadable", () => {
    expect(selectorForFunction(PAUSABLE, "withdraw")).toBeNull();
    expect(selectorForFunction(PAUSABLE, "missing")).toBeNull();
    expect(selectorForFunction("not json", "pause")).toBeNull();
    expect(selectorForFunction(PAUSABLE, "")).toBeNull();
  });
});
