// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOGGLE_FIELD_RENDERERS } from "@/components/workflow/config/toggle-field-renderers";
import {
  clearUnsponsoredOnlyFields,
  UNSPONSORED_ONLY_FIELD_KEYS,
} from "@/lib/web3/unsponsored-only-fields";
import { buildConfigForActionTypeChange } from "@/lib/workflow/editor/action-type-transition";
import {
  applyConfigUpdate,
  clearedFieldsNotice,
  isFieldEditable,
} from "@/lib/workflow/editor/config-update";
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

describe("applyConfigUpdate: fees locked while sponsored", () => {
  const FEES = { priorityFeeGwei: "3", maxFeeGwei: "50" };
  const WRITE = "web3/write-contract";
  const BATCH = "web3/batch-write-contract";

  // One editor update outside any batch, as a single click sends it.
  function update(
    config: Record<string, unknown>,
    key: string,
    value: unknown
  ): Record<string, unknown> {
    return applyConfigUpdate(null, config, key, value).config;
  }

  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_GAS_SPONSORSHIP_ENABLED", "true");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("clears every unsponsored-only setting when Sponsor gas is turned on", () => {
    const before = {
      actionType: WRITE,
      network: "1",
      sponsorGas: false,
      ...FEES,
    };
    const after = update(before, "sponsorGas", true);
    for (const key of UNSPONSORED_ONLY_FIELD_KEYS) {
      expect(after[key]).toBe("");
    }
  });

  it("clears them when Simulate at goes back to Latest block with Sponsor gas on", () => {
    // Fees set under Next block, Sponsor gas then turned on: still unsponsored.
    const nextBlock = {
      actionType: WRITE,
      network: "1",
      simulateAt: "next-block",
      sponsorGas: false,
      ...FEES,
    };
    const sponsorOn = update(nextBlock, "sponsorGas", true);
    expect(sponsorOn).toEqual({ ...nextBlock, sponsorGas: true });

    const after = update(sponsorOn, "simulateAt", "latest");
    expect(after.priorityFeeGwei).toBe("");
    expect(after.maxFeeGwei).toBe("");
  });

  it("clears them when the network changes to a sponsored one", () => {
    const optimism = { actionType: WRITE, network: "10", ...FEES };
    expect(update(optimism, "network", "8453").maxFeeGwei).toBe("");
  });

  it("keeps the settings when the node stays unsponsored", () => {
    const before = {
      actionType: WRITE,
      network: "1",
      sponsorGas: true,
      ...FEES,
    };
    expect(update(before, "sponsorGas", false)).toEqual({
      ...before,
      sponsorGas: false,
    });
    const viaSafe = {
      ...before,
      sponsorGas: false,
      web3Connection: "safe:abc",
    };
    expect(update(viaSafe, "sponsorGas", true)).toEqual({
      ...viaSafe,
      sponsorGas: true,
    });
  });

  it("keeps the fees when Sponsor gas is turned off", () => {
    const sponsored = {
      actionType: WRITE,
      network: "1",
      sponsorGas: true,
      simulateAt: "next-block",
      ...FEES,
    };
    expect(update(sponsored, "sponsorGas", false)).toEqual({
      ...sponsored,
      sponsorGas: false,
    });
  });

  it("never clears a field the form does not show (hidden)", () => {
    const fee = {
      key: "maxFeeGwei",
      label: "Max Fee (gwei)",
      type: "template-input" as const,
      hidden: true,
      enabledWhen: {
        when: { computed: "notSponsored" as const, networkField: "network" },
        hint: "",
      },
    };
    const before = { network: "1", sponsorGas: false, maxFeeGwei: "50" };
    const after = { ...before, sponsorGas: true };
    expect(
      clearUnsponsoredOnlyFields(
        { config: before, fields: [fee] },
        { config: after, fields: [fee] },
        isFieldEditable
      )
    ).toBe(after);
  });

  it("does not touch settings that are already empty", () => {
    const before = { actionType: WRITE, network: "1", sponsorGas: false };
    expect(update(before, "sponsorGas", true)).toEqual({
      ...before,
      sponsorGas: true,
    });
  });

  it("never clears Batch Write's fees, which always show and always apply", () => {
    const batch = {
      actionType: BATCH,
      network: "8453",
      simulateAt: "next-block",
      ...FEES,
    };
    expect(update(batch, "simulateAt", "latest")).toEqual({
      ...batch,
      simulateAt: "latest",
    });
    const optimism = { ...batch, network: "10", simulateAt: "latest" };
    expect(update(optimism, "network", "1")).toEqual({
      ...optimism,
      network: "1",
    });
  });

  it("judges a batch of updates from its start: picking a Flashbots network keeps fees", () => {
    // The network select sends `network`, then `usePrivateMempool`, in one tick.
    const optimism = { actionType: WRITE, network: "10", ...FEES };
    const first = applyConfigUpdate(null, optimism, "network", "1");
    const second = applyConfigUpdate(
      first.batch,
      optimism,
      "usePrivateMempool",
      true
    );
    expect(second.config).toEqual({
      ...optimism,
      network: "1",
      usePrivateMempool: true,
    });
  });

  it("clears when the network select moves to a sponsored network in one batch", () => {
    // Optimism -> Base: `network`, then `usePrivateMempool: false`.
    const optimism = { actionType: WRITE, network: "10", ...FEES };
    const first = applyConfigUpdate(null, optimism, "network", "8453");
    const second = applyConfigUpdate(
      first.batch,
      optimism,
      "usePrivateMempool",
      false
    );
    expect(second.config.maxFeeGwei).toBe("");
    expect(second.config.priorityFeeGwei).toBe("");
  });

  it("clears fees a Batch Write allowed once the node becomes a sponsored Write Contract", () => {
    const batch = { actionType: BATCH, network: "8453", ...FEES };
    const { config } = applyConfigUpdate(
      null,
      batch,
      "actionType",
      WRITE,
      (merged) => buildConfigForActionTypeChange(WRITE, merged)
    );
    expect(config.sponsorGas).toBe("true");
    expect(config.maxFeeGwei).toBe("");
    expect(config.priorityFeeGwei).toBe("");
  });

  it("keeps fees across an action type change when they stay editable", () => {
    const batch = { actionType: BATCH, network: "10", ...FEES };
    const { config } = applyConfigUpdate(
      null,
      batch,
      "actionType",
      WRITE,
      (merged) => buildConfigForActionTypeChange(WRITE, merged)
    );
    expect(config.maxFeeGwei).toBe("50");
  });

  it("keeps an action type change's pruning for later updates in the same tick", () => {
    const write = { actionType: WRITE, network: "10", simulateAt: "latest" };
    const changed = applyConfigUpdate(
      null,
      write,
      "actionType",
      "web3/read-contract",
      (merged) => buildConfigForActionTypeChange("web3/read-contract", merged)
    );
    const next = applyConfigUpdate(changed.batch, write, "network", "1");
    expect(next.config.actionType).toBe("web3/read-contract");
    expect("sponsorGas" in next.config).toBe(false);
  });

  it("leaves a fee that was already locked alone (a config saved outside the editor)", () => {
    const saved = {
      actionType: WRITE,
      network: "8453",
      sponsorGas: "true",
      maxFeeGwei: "50",
    };
    expect(update(saved, "functionName", "run").maxFeeGwei).toBe("50");
    expect(update(saved, "sponsorGas", "true").maxFeeGwei).toBe("50");
  });

  it("lists the cleared fields for the editor's notice, once the batch ends", () => {
    const off = { actionType: WRITE, network: "1", sponsorGas: false, ...FEES };
    const { batch } = applyConfigUpdate(null, off, "sponsorGas", true);
    expect(batch.cleared).toEqual(["Priority Fee (gwei)", "Max Fee (gwei)"]);
    expect(clearedFieldsNotice(batch.cleared)).toBe(
      "Priority Fee and Max Fee cleared: Sponsor gas is on, so the sponsor sets the fees. Turn off Sponsor gas to set them again."
    );

    // Flashbots: midway sponsored, final not: nothing cleared at the end.
    const optimism = { actionType: WRITE, network: "10", ...FEES };
    const first = applyConfigUpdate(null, optimism, "network", "1");
    expect(first.batch.cleared.length).toBeGreaterThan(0);
    const second = applyConfigUpdate(
      first.batch,
      optimism,
      "usePrivateMempool",
      true
    );
    expect(second.batch.cleared).toEqual([]);
  });

  it("clears once a batch ends sponsored", () => {
    const flashbots = {
      actionType: WRITE,
      network: "1",
      usePrivateMempool: true,
      ...FEES,
    };
    const first = applyConfigUpdate(null, flashbots, "network", "8453");
    const second = applyConfigUpdate(
      first.batch,
      flashbots,
      "usePrivateMempool",
      false
    );
    expect(second.config.maxFeeGwei).toBe("");
    expect(second.config.priorityFeeGwei).toBe("");
  });
});

describe("editor config handlers", () => {
  // Both panels must route every field update through the shared rule.
  it.each([
    "components/workflow/node-config-panel.tsx",
    "components/overlays/configuration-overlay.tsx",
  ])("%s applies updates with applyConfigUpdate", (path) => {
    const source = readFileSync(path, "utf8");
    expect(source).toMatch(
      /applyConfigUpdate\(\s*pendingConfigRef\.current,\s*selectedNode\.data\.config/
    );
    expect(source).toMatch(/pendingConfigRef\.current = batch;/);
    expect(source).not.toMatch(/pendingConfigRef\.current = newConfig/);
    // The notice reads the finished batch, after the same-tick updates.
    expect(source).toMatch(
      /const finished = pendingConfigRef\.current;[\s\S]{0,200}clearedFieldsNotice\(finished\.cleared\)/
    );
  });
});
