import { describe, expect, it } from "vitest";
import { SLOT_CLOCK_GENESIS } from "@/keeperhub-scheduler/lib/slot-clock";
import { ETHEREUM_L1_CHAIN_IDS } from "@/lib/web3/ethereum-l1";
import {
  isSkipIfRunningSupported,
  isSlotClockChain,
  missedSlotRunsApply,
} from "@/lib/workflow/block-trigger-switches";
import { getTriggerOutputFields } from "@/lib/workflow/editor/trigger-output-fields";
import { validateWorkflowActionConfigs } from "@/lib/workflow/validation/action-config";

function blockTrigger(config: Record<string, unknown>) {
  return [
    {
      id: "trigger",
      type: "trigger",
      data: {
        type: "trigger",
        label: "Block",
        config: {
          triggerType: "Block",
          network: "1",
          blockInterval: "1",
          ...config,
        },
      },
    },
  ];
}

describe("Block Trigger switches on save", () => {
  it.each([undefined, "", "true", "false", true, false])(
    "accepts %s",
    (value) => {
      const result = validateWorkflowActionConfigs(
        blockTrigger({ skipIfRunning: value, runOnMissedSlot: value })
      );
      expect(result.valid).toBe(true);
    }
  );

  it.each(["yes", "{{@a:A.flag}}", 1])("refuses %s", (value) => {
    const result = validateWorkflowActionConfigs(
      blockTrigger({ skipIfRunning: value })
    );
    expect(result.valid).toBe(false);
    expect(result.issues[0]).toMatchObject({
      code: "INVALID_FIELD_VALUE",
      field: "skipIfRunning",
      path: "nodes[0].data.config.skipIfRunning",
    });
    // Named by its label, as the editor shows it.
    expect(result.issues[0].message).toMatch(
      /^Skip if the previous run is still running /
    );
  });

  it("keeps runOnMissedSlot on a network without a slot clock (ignored there)", () => {
    const result = validateWorkflowActionConfigs(
      blockTrigger({ network: "8453", runOnMissedSlot: "true" })
    );
    expect(result.valid).toBe(true);
  });
});

describe("Block Trigger switch helpers", () => {
  it("covers Ethereum mainnet, Sepolia and Hoodi only for the slot clock", () => {
    expect(isSlotClockChain("1")).toBe(true);
    expect(isSlotClockChain(11_155_111)).toBe(true);
    expect(isSlotClockChain("560048")).toBe(true);
    for (const other of ["8453", "137", "", undefined, "1.5"]) {
      expect(isSlotClockChain(other)).toBe(false);
    }
  });

  it("offers skip-if-running on EVM networks, not on Solana", () => {
    expect(isSkipIfRunningSupported("1")).toBe(true);
    expect(isSkipIfRunningSupported("8453")).toBe(true);
    expect(isSkipIfRunningSupported("101")).toBe(false);
    expect(isSkipIfRunningSupported("103")).toBe(false);
  });

  it('reads the switch true and "true" alike, anything else as off', () => {
    const at = (runOnMissedSlot: unknown): boolean =>
      missedSlotRunsApply({ network: "1", runOnMissedSlot });
    for (const on of [true, "true"]) {
      expect(at(on)).toBe(true);
    }
    for (const off of [false, "false", "", undefined, "yes", 1]) {
      expect(at(off)).toBe(false);
    }
  });

  it("uses the scheduler's slot-clock chains", () => {
    expect(Object.keys(SLOT_CLOCK_GENESIS).map(Number).sort()).toEqual(
      [...ETHEREUM_L1_CHAIN_IDS].sort()
    );
  });

  it("applies missed-slot runs with the option on, a slot clock and Block Interval 1", () => {
    const on = { network: "1", runOnMissedSlot: true, blockInterval: "1" };
    expect(missedSlotRunsApply(on)).toBe(true);
    expect(missedSlotRunsApply({ ...on, blockInterval: "" })).toBe(true);
    expect(missedSlotRunsApply({ ...on, blockInterval: "10" })).toBe(false);
    expect(missedSlotRunsApply({ ...on, network: "8453" })).toBe(false);
    expect(missedSlotRunsApply({ ...on, runOnMissedSlot: "false" })).toBe(
      false
    );
  });
});

describe("Block Trigger output fields", () => {
  const fieldsOf = (config: Record<string, unknown>): string[] =>
    getTriggerOutputFields("Block", config).map((f) => f.field);
  const on = { network: "1", blockInterval: "1", runOnMissedSlot: "true" };

  it("lists the slot fields exactly when missed-slot runs apply", () => {
    expect(fieldsOf(on)).toEqual(
      expect.arrayContaining([
        "missedSlot",
        "slotTimestamp",
        "targetSlot",
        "targetSlotTimestamp",
      ])
    );
    expect(fieldsOf({ ...on, runOnMissedSlot: true })).toContain("missedSlot");
    expect(fieldsOf({ ...on, blockInterval: "10" })).not.toContain(
      "missedSlot"
    );
    expect(fieldsOf({ ...on, network: "8453" })).not.toContain("missedSlot");
    expect(fieldsOf({ network: "1" })).not.toContain("missedSlot");
  });
});
