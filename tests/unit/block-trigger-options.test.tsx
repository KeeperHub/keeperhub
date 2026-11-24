// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BlockTriggerOptions } from "@/components/workflow/config/block-trigger-options";

let container: HTMLDivElement;
let root: Root;

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
});

function render(
  config: Record<string, unknown>,
  onUpdateConfig = vi.fn()
): typeof onUpdateConfig {
  act(() => {
    root.render(
      <BlockTriggerOptions
        config={config}
        disabled={false}
        onUpdateConfig={onUpdateConfig}
      />
    );
  });
  return onUpdateConfig;
}

const switchOf = (id: string): HTMLButtonElement | null =>
  container.querySelector(`button#${id}`);

describe("BlockTriggerOptions", () => {
  it.each([
    ["1", "1"],
    ["11155111", "1"],
    ["1", "10"],
  ])(
    "shows both switches, off by default, on network %s at interval %s",
    (network, blockInterval) => {
      render({ network, blockInterval });
      expect(switchOf("skipIfRunning")?.getAttribute("aria-checked")).toBe(
        "false"
      );
      expect(switchOf("runOnMissedSlot")?.getAttribute("aria-checked")).toBe(
        "false"
      );
      expect(container.textContent).toContain(
        "Ethereum only. Works only with Block Interval 1. When no block arrives 4 s into a slot, the workflow runs anyway."
      );
    }
  );

  it.each(["8453", "137", ""])(
    "hides the missed-slot switch on network %s",
    (network) => {
      render({ network, runOnMissedSlot: "false" });
      expect(switchOf("skipIfRunning")).not.toBeNull();
      expect(switchOf("runOnMissedSlot")).toBeNull();
    }
  );

  it.each(["101", "103"])("shows no switch on Solana network %s", (network) => {
    render({ network, skipIfRunning: "true" });
    expect(container.innerHTML).toBe("");
  });

  it('reads boolean true like "true" and stores the switch as a string', () => {
    const onUpdateConfig = render({ network: "1", skipIfRunning: true });
    expect(switchOf("skipIfRunning")?.getAttribute("aria-checked")).toBe(
      "true"
    );
    act(() => switchOf("runOnMissedSlot")?.click());
    expect(onUpdateConfig).toHaveBeenCalledWith("runOnMissedSlot", "true");
  });

  it("words a stray value for a trigger, not a step", () => {
    render({ network: "1", skipIfRunning: "yes" });
    expect(container.textContent).toContain(
      "The trigger reads it as off. A save refuses it, so reset it to save."
    );
    expect(container.textContent).not.toContain("When the step runs");
  });

  it("tells a read-only viewer nothing about resetting", () => {
    act(() => {
      root.render(
        <BlockTriggerOptions
          config={{ network: "1", skipIfRunning: "yes" }}
          disabled
          onUpdateConfig={vi.fn()}
        />
      );
    });
    expect(container.textContent).toContain("The trigger reads it as off.");
    expect(container.textContent).not.toContain("reset");
  });

  it.each([
    ["8453", "runOnMissedSlot"],
    ["101", "skipIfRunning"],
  ])(
    "on network %s shows the unused %s locked while it holds a stray value; reset moves focus to Network",
    (network, key) => {
      const onUpdateConfig = vi.fn();
      act(() => {
        root.render(
          <div>
            <button id="network" type="button">
              Network
            </button>
            <BlockTriggerOptions
              config={{ network, [key]: "yes" }}
              disabled={false}
              onUpdateConfig={onUpdateConfig}
            />
          </div>
        );
      });
      expect(switchOf(key)?.disabled).toBe(true);
      expect(container.textContent).toContain(
        'Not used on this network. It holds "yes", which is neither on nor off.'
      );
      expect(container.textContent).not.toContain("reset it");
      const reset = [...container.querySelectorAll("button")].find((b) =>
        b.textContent?.startsWith("Reset to default")
      );
      act(() => reset?.click());
      expect(onUpdateConfig).toHaveBeenCalledWith(key, "");
      expect(document.activeElement?.id).toBe("network");
    }
  );
});
