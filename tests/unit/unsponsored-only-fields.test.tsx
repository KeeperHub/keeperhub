// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOGGLE_FIELD_RENDERERS } from "@/components/workflow/config/toggle-field-renderers";
import { UNSPONSORED_ONLY_FIELD_KEYS } from "@/lib/web3/unsponsored-only-fields";
import { sponsorGasField } from "@/plugins/field-fragments";

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

function renderSponsorToggle(
  config: Record<string, unknown>,
  onUpdateConfig: (key: string, value: unknown) => void
): void {
  const renderer = TOGGLE_FIELD_RENDERERS["gas-sponsorship-switch"];
  act(() => {
    root.render(
      renderer({ field: sponsorGasField(), config, onUpdateConfig }) as never
    );
  });
}

function clickToggle(): void {
  const toggle = container.querySelector<HTMLButtonElement>("#sponsorGas");
  act(() => toggle?.click());
}

describe("Sponsor gas toggle and unsponsored-only settings", () => {
  it("clears every unsponsored-only setting when Sponsor gas is turned on", () => {
    const onUpdateConfig = vi.fn();
    const config: Record<string, unknown> = { sponsorGas: false };
    for (const key of UNSPONSORED_ONLY_FIELD_KEYS) {
      config[key] = "3";
    }
    renderSponsorToggle(config, onUpdateConfig);

    clickToggle();

    expect(onUpdateConfig).toHaveBeenCalledWith("sponsorGas", true);
    for (const key of UNSPONSORED_ONLY_FIELD_KEYS) {
      expect(onUpdateConfig).toHaveBeenCalledWith(key, "");
    }
  });

  it("keeps the settings when Sponsor gas is turned off", () => {
    const onUpdateConfig = vi.fn();
    renderSponsorToggle(
      { sponsorGas: true, priorityFeeGwei: "3" },
      onUpdateConfig
    );

    clickToggle();

    expect(onUpdateConfig).toHaveBeenCalledWith("sponsorGas", false);
    expect(onUpdateConfig).not.toHaveBeenCalledWith("priorityFeeGwei", "");
  });

  it("does not touch settings that are already empty", () => {
    const onUpdateConfig = vi.fn();
    renderSponsorToggle({ sponsorGas: false }, onUpdateConfig);

    clickToggle();

    expect(onUpdateConfig).toHaveBeenCalledTimes(1);
  });
});
