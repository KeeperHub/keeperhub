// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OverlayProvider } from "@/components/overlays/overlay-provider";
import { EventListField } from "@/components/workflow/config/event-list-field";
import type { ActionConfigFieldBase } from "@/plugins/registry";

const VAULT = "0x1111111111111111111111111111111111111111";
const TOKEN = "0x2222222222222222222222222222222222222222";
const ALICE = "0x4444444444444444444444444444444444444444";
const BOB = "0x5555555555555555555555555555555555555555";

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
  {
    type: "event",
    name: "Paused",
    inputs: [{ name: "account", type: "address", indexed: false }],
  },
]);

const field: ActionConfigFieldBase = {
  key: "eventQueries",
  label: "Events",
  type: "event-list-builder",
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  // The ABI field loads the chain list on mount.
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ json: () => Promise.resolve([]) })
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

async function render(value: unknown): Promise<ReturnType<typeof vi.fn>> {
  const onChange = vi.fn();
  await act(async () => {
    root.render(
      <OverlayProvider>
        <EventListField
          actionConfig={{ network: "1" }}
          field={field}
          onChange={onChange}
          value={value}
        />
      </OverlayProvider>
    );
  });
  return onChange;
}

function lastSaved(
  onChange: ReturnType<typeof vi.fn>
): Record<string, unknown>[] {
  return JSON.parse(onChange.mock.calls.at(-1)?.[0] as string);
}

describe("EventListField", () => {
  it("shows each stored entry and saves a filter edit as an object", async () => {
    const onChange = await render([
      {
        contractAddress: TOKEN,
        abi: ABI,
        eventName: "Transfer",
        eventArgs: { from: ALICE },
      },
      { contractAddress: VAULT, abi: ABI, eventName: "Paused" },
    ]);

    expect(container.textContent).toContain("Event 1");
    expect(container.textContent).toContain("Event 2");
    const from =
      container.querySelector<HTMLInputElement>("input[id$='-from']");
    const to = container.querySelector<HTMLInputElement>("input[id$='-to']");
    expect(from?.value).toBe(ALICE);

    const setValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set;
    await act(async () => {
      setValue?.call(to, BOB);
      to?.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const saved = lastSaved(onChange);
    expect(saved[0]).toMatchObject({
      contractAddress: TOKEN,
      eventName: "Transfer",
      eventArgs: { from: ALICE, to: BOB },
    });
    expect(saved[1]).toMatchObject({
      contractAddress: VAULT,
      eventName: "Paused",
    });
    expect(saved[1]).not.toHaveProperty("eventArgs");
  });

  it("reads the JSON string the editor stores and keeps an added row even while empty", async () => {
    const onChange = await render(
      JSON.stringify([
        { contractAddress: VAULT, abi: ABI, eventName: "Paused" },
      ])
    );

    const add = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Add Event")
    );
    await act(async () => {
      add?.click();
    });

    expect(container.textContent).toContain("Event 2");
    expect(lastSaved(onChange)).toEqual([
      expect.objectContaining({ contractAddress: VAULT, eventName: "Paused" }),
      expect.objectContaining({ contractAddress: "", abi: "", eventName: "" }),
    ]);
  });
});
