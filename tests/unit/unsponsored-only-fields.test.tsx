// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOGGLE_FIELD_RENDERERS } from "@/components/workflow/config/toggle-field-renderers";
import {
  clearUnsponsoredOnlyFields,
  UNSPONSORED_ONLY_FIELD_KEYS,
} from "@/lib/web3/unsponsored-only-fields";
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

describe("Sponsor gas toggle", () => {
  it("only sets Sponsor gas; clearing fees is the general config rule", () => {
    const onUpdateConfig = vi.fn();
    renderSponsorToggle(
      { sponsorGas: false, priorityFeeGwei: "3" },
      onUpdateConfig
    );

    clickToggle();

    expect(onUpdateConfig).toHaveBeenCalledTimes(1);
    expect(onUpdateConfig).toHaveBeenCalledWith("sponsorGas", true);
  });
});

describe("clearUnsponsoredOnlyFields", () => {
  const FEES = { priorityFeeGwei: "3", maxFeeGwei: "50" };

  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_GAS_SPONSORSHIP_ENABLED", "true");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("clears every unsponsored-only setting when Sponsor gas is turned on", () => {
    const before = { network: "1", sponsorGas: false, ...FEES };
    const after = clearUnsponsoredOnlyFields(before, {
      ...before,
      sponsorGas: true,
    });
    for (const key of UNSPONSORED_ONLY_FIELD_KEYS) {
      expect(after[key]).toBe("");
    }
  });

  it("clears them when Simulate at goes back to Latest block with Sponsor gas on", () => {
    // Fees set under Next block, Sponsor gas then turned on: still unsponsored.
    const nextBlock = {
      network: "1",
      simulateAt: "next-block",
      sponsorGas: true,
      ...FEES,
    };
    expect(
      clearUnsponsoredOnlyFields({ ...nextBlock, sponsorGas: false }, nextBlock)
    ).toEqual(nextBlock);

    const after = clearUnsponsoredOnlyFields(nextBlock, {
      ...nextBlock,
      simulateAt: "latest",
    });
    expect(after.priorityFeeGwei).toBe("");
    expect(after.maxFeeGwei).toBe("");
  });

  it("keeps the settings when the node stays unsponsored", () => {
    const before = { network: "1", sponsorGas: true, ...FEES };
    const off = { ...before, sponsorGas: false };
    expect(clearUnsponsoredOnlyFields(before, off)).toBe(off);
    const viaSafe = { ...off, web3Connection: "safe:abc" };
    expect(
      clearUnsponsoredOnlyFields(viaSafe, { ...viaSafe, sponsorGas: true })
    ).toEqual({ ...viaSafe, sponsorGas: true });
  });

  it("does not touch settings that are already empty", () => {
    const before = { network: "1", sponsorGas: false };
    const after = { ...before, sponsorGas: true };
    expect(clearUnsponsoredOnlyFields(before, after)).toBe(after);
  });
});
