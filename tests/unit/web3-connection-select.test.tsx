// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Web3ConnectionSelect } from "@/components/workflow/config/web3-connection-select";

const BATCH_NOTE =
  "Batch Write Contract sends from your EOA. Your Default Sender here is a Safe, so this step fails unless you pick EOA. Use Write Contract steps to send from the Safe.";
const BYPASS_WARNING =
  "Selecting EOA bypasses the org Safe Wallet including any policy gating.";

let container: HTMLDivElement;
let root: Root;
const onChange = vi.fn();

function stubOptions(defaultKind: "eoa" | "safe"): void {
  const options = [
    { value: "default", label: "Default", kind: "default" },
    { value: "eoa", label: "EOA", kind: "eoa" },
    ...(defaultKind === "safe"
      ? [
          {
            value: "safe:s1",
            label: "Safe 0xabc",
            kind: "safe",
            safeAddress: "0xabc",
          },
        ]
      : []),
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ defaultKind, options }),
    })
  );
}

async function render(props: {
  value?: string;
  safesAllowed?: boolean;
}): Promise<void> {
  await act(async () => {
    root.render(
      <Web3ConnectionSelect
        network="1"
        onChange={onChange}
        safesAllowed={props.safesAllowed}
        value={props.value}
      />
    );
  });
}

async function openOptions(): Promise<string[]> {
  const trigger = container.querySelector("[role=combobox]") as HTMLElement;
  await act(async () => {
    trigger.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        pointerType: "mouse",
      })
    );
  });
  return Array.from(document.querySelectorAll("[role=option]")).map(
    (o) => o.textContent ?? ""
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  // jsdom has no pointer capture or scrolling; Radix Select needs both to open.
  Object.assign(HTMLElement.prototype, {
    hasPointerCapture: () => false,
    setPointerCapture: () => undefined,
    releasePointerCapture: () => undefined,
    scrollIntoView: () => undefined,
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("Web3ConnectionSelect on Batch Write Contract", () => {
  it("says a Safe Default Sender fails, and does not switch the value", async () => {
    stubOptions("safe");
    await render({ safesAllowed: false });

    expect(container.textContent).toContain(BATCH_NOTE);
    expect(container.textContent).not.toContain(BYPASS_WARNING);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("drops the note, and shows no bypass warning, once EOA is picked", async () => {
    stubOptions("safe");
    await render({ safesAllowed: false, value: "eoa" });

    expect(container.textContent).not.toContain(BATCH_NOTE);
    expect(container.textContent).not.toContain(BYPASS_WARNING);
  });

  it("shows no note when the Default Sender is the EOA", async () => {
    stubOptions("eoa");
    await render({ safesAllowed: false });

    expect(container.textContent).not.toContain(BATCH_NOTE);
  });

  it("says why a stored Safe cannot be used", async () => {
    stubOptions("safe");
    await render({ safesAllowed: false, value: "safe:s1" });

    const options = await openOptions();
    const stale = options.find((o) => o.includes("Unavailable (safe:s1)"));
    expect(stale).toContain("Batch Write Contract cannot send from a Safe.");
    expect(options.some((o) => o.includes("Safe 0xabc"))).toBe(false);
  });
});

describe("Web3ConnectionSelect on a step that takes a Safe", () => {
  it("warns that EOA bypasses a Safe Default Sender", async () => {
    stubOptions("safe");
    await render({ value: "eoa" });

    expect(container.textContent).toContain(BYPASS_WARNING);
    expect(container.textContent).not.toContain(BATCH_NOTE);
  });

  it("asks for a sender when a picked Safe is not available here", async () => {
    stubOptions("safe");
    await render({ value: "safe:gone" });

    const options = await openOptions();
    expect(options.find((o) => o.includes("safe:gone"))).toContain(
      "This Safe is not available here. Pick a sender."
    );
  });

  it("calls a stale value that is not a Safe an invalid sender", async () => {
    stubOptions("safe");
    await render({ value: "EOA" });

    const options = await openOptions();
    const stale = options.find((o) => o.includes("Unavailable (EOA)"));
    expect(stale).toContain("Not a valid sender. Pick one.");
    expect(stale).not.toContain("Safe");
  });
});
