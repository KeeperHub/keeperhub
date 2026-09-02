/**
 * An on-chain trigger holds its chain in its own node config and nowhere else,
 * so unless the trigger's step log carries it, a run whose later steps name no
 * chain (a notification, an HTTP call) reaches /analytics with an empty Network
 * column. The executor passes `network` alongside `triggerData`; these cover
 * that it survives to the logged input, and that the writer turns that input
 * into the denormalised `network` column /analytics reads.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const logStepStartDb = vi.fn();
const logStepCompleteDb = vi.fn();
const incrementCompletedSteps = vi.fn();
const logWorkflowCompleteDb = vi.fn();
const updateCurrentStep = vi.fn();
const updateForEachLogToError = vi.fn();

vi.mock("@/lib/workflow/executor/logging", () => ({
  logStepStartDb,
  logStepCompleteDb,
  incrementCompletedSteps,
  logWorkflowCompleteDb,
  updateCurrentStep,
  updateForEachLogToError,
}));

const { triggerStep } = await import("@/lib/workflow/nodes/trigger/step");
const { extractLogGasUsedWei, extractLogNetwork } = await import(
  "@/lib/db/execution-log-fields"
);
const { triggerConfigNetwork } = await import(
  "@/lib/workflow/executor/executor.workflow"
);

const context = {
  executionId: "exec-1",
  nodeId: "trigger_1",
  nodeName: "Event",
  nodeType: "trigger",
};

function loggedInput(): unknown {
  return logStepStartDb.mock.calls[0][0].input;
}

describe("triggerConfigNetwork", () => {
  it("reads the chain an on-chain trigger is configured against", () => {
    expect(
      triggerConfigNetwork({ triggerType: "Event", network: "8453" })
    ).toBe("8453");
  });

  it("normalises a numeric chain id to the text the log column holds", () => {
    expect(triggerConfigNetwork({ triggerType: "Block", network: 8453 })).toBe(
      "8453"
    );
  });

  it("yields nothing for a trigger with no chain", () => {
    expect(triggerConfigNetwork({ triggerType: "Schedule" })).toBeUndefined();
  });
});

describe("trigger step network logging", () => {
  beforeEach(() => {
    logStepStartDb.mockReset();
    logStepCompleteDb.mockReset();
    updateCurrentStep.mockReset();
    logStepStartDb.mockResolvedValue({ logId: "log-1", startTime: 100 });
    logStepCompleteDb.mockResolvedValue(undefined);
  });

  it("logs the trigger's chain so analytics can read it", async () => {
    await triggerStep({
      triggerData: { triggered: true, from: "0xabc" },
      network: "8453",
      _context: context,
    });

    expect(extractLogNetwork(loggedInput())).toBe("8453");
  });

  it("still returns only the trigger data to downstream steps", async () => {
    const result = await triggerStep({
      triggerData: { triggered: true, amount: 5 },
      network: "8453",
      _context: context,
    });

    expect(result.data).toEqual({ triggered: true, amount: 5 });
  });

  it("reports the triggering transaction's gas under its own key", async () => {
    const result = await triggerStep({
      triggerData: { triggered: true, transactionHash: "0xabc" },
      network: "8453",
      triggerGasUsed: "77000",
      _context: context,
    });

    // Never as `gasUsed`: that is the key resolveGasTotal and the analytics
    // rollups sum, and this fee was paid by whoever emitted the event.
    expect(extractLogGasUsedWei(result)).toBeNull();
    expect(result.triggerGasUsed).toBe("77000");
  });

  it("omits the key entirely when no gas could be read", async () => {
    const result = await triggerStep({
      triggerData: { triggered: true },
      network: "8453",
      _context: context,
    });

    expect(result).not.toHaveProperty("triggerGasUsed");
  });

  it("records no chain for a trigger that has none", async () => {
    await triggerStep({
      triggerData: { triggered: true },
      _context: context,
    });

    expect(extractLogNetwork(loggedInput())).toBeNull();
  });
});
