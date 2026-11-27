import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { transformPluginAction } from "@/lib/action-schemas/builder";
import { preparePinDataForWorkflow } from "@/lib/mcp/prepare-test-pin-data";
import { bundleTipsText } from "@/lib/web3/bundles/editor-text";
import { bundleLoopRefusal } from "@/lib/web3/bundles/loop-rule";
import { readInteger, readNameList } from "@/lib/web3/bundles/settings";
import {
  notIncludedReasonText,
  STEP_OUTCOME_TEXT,
  stepOutcomeOf,
  stepOutcomeTitle,
} from "@/lib/workflow/executor/run-outcome-keys";
import { canvasNodeStatus } from "@/lib/workflow/store";
import { validateWorkflowActionConfigs } from "@/lib/workflow/validation/action-config";
import { getIntegration } from "@/plugins/registry";

describe("bundleTipsText", () => {
  const RAISED =
    " Later tips stop at the network's tip limit. The step raises its fee cap to pay them, up to";

  it("with Max Fee empty, lists each block's tip as paid and the 10,000 gwei ceiling", () => {
    expect(
      bundleTipsText({
        blocks: 5,
        increasePercent: 50,
        priorityFeeGwei: "1",
        maxFeeGwei: "",
      })
    ).toBe(
      `Tips: 1, 1.5, 2.25, 3.38 and 5.06 gwei, from Priority Fee in Advanced.${RAISED} 10,000 gwei, and the wallet must hold Gas Limit x that cap.`
    );
  });

  it("with Max Fee set, caps the tips there and says a tip is paid only up to what it leaves", () => {
    expect(
      bundleTipsText({
        blocks: 2,
        increasePercent: 100,
        priorityFeeGwei: 1,
        maxFeeGwei: "1.5",
      })
    ).toBe(
      `Tips: 1 and 1.5 gwei, from Priority Fee in Advanced.${RAISED} Max Fee, and the wallet must hold Gas Limit x that cap. A tip is paid only up to what the 1.5 gwei Max Fee leaves above the base fee.`
    );
  });

  it("never lists a tip above the highest Max Fee", () => {
    expect(
      bundleTipsText({
        blocks: 3,
        increasePercent: 100,
        priorityFeeGwei: "4000",
        maxFeeGwei: "",
      })
    ).toContain("Tips: 4000, 8000 and 10000 gwei");
  });

  it("describes the rule when Priority Fee is not a plain number", () => {
    expect(
      bundleTipsText({
        blocks: 3,
        increasePercent: 0,
        priorityFeeGwei: "",
        maxFeeGwei: undefined,
      })
    ).toBe(
      "Every block gets the same tip: Priority Fee in Advanced, or the network's default."
    );
    expect(
      bundleTipsText({
        blocks: 3,
        increasePercent: 10,
        priorityFeeGwei: "{{@n:N.tip}}",
        maxFeeGwei: "20",
      })
    ).toBe(
      `Each later block's tip is 10% higher than the one before, starting from Priority Fee in Advanced (or the network's default), so the last block's tip is up to 1.21x the first.${RAISED} Max Fee, and the wallet must hold Gas Limit x that cap. A tip is paid only up to what the 20 gwei Max Fee leaves above the base fee.`
    );
  });

  it("stops listed tips at the network's tip limit, as the step plans them", () => {
    const limited = bundleTipsText({
      blocks: 4,
      increasePercent: 100,
      priorityFeeGwei: "1",
      maxFeeGwei: "",
      tipLimitGwei: 3,
    });
    expect(limited).toContain("Tips: 1, 2, 3 and 3 gwei");
    expect(limited).toContain(
      "Later tips stop at the network's tip limit (3 gwei on this network)."
    );
    // A Priority Fee above the limit keeps the first tip for every block, and the line says so.
    const above = bundleTipsText({
      blocks: 3,
      increasePercent: 50,
      priorityFeeGwei: "8",
      maxFeeGwei: "",
      tipLimitGwei: 5,
    });
    expect(above).toContain("Tips: 8, 8 and 8 gwei");
    expect(above).toContain(
      "Later tips stay at your Priority Fee, which is above the network's tip limit (5 gwei on this network)."
    );
    expect(above).not.toContain("stop at the network's tip limit");
    // At the limit exactly, tips still stop there.
    expect(
      bundleTipsText({
        blocks: 2,
        increasePercent: 50,
        priorityFeeGwei: "5",
        maxFeeGwei: "",
        tipLimitGwei: 5,
      })
    ).toContain(
      "Later tips stop at the network's tip limit (5 gwei on this network)."
    );
  });

  it("says how large the last block's tip can get with Priority Fee empty", () => {
    expect(
      bundleTipsText({
        blocks: 5,
        increasePercent: 100,
        priorityFeeGwei: "",
        maxFeeGwei: "",
      })
    ).toContain("so the last block's tip is up to 16x the first.");
    expect(
      bundleTipsText({
        blocks: 1,
        increasePercent: 100,
        priorityFeeGwei: "",
        maxFeeGwei: "",
      })
    ).not.toContain("last block");
  });
});

describe("the shared readers", () => {
  it("reads whole numbers in range only", () => {
    expect(readInteger("3", { min: 1, max: 5 })).toBe(3);
    expect(readInteger(5, { min: 1, max: 5 })).toBe(5);
    for (const value of ["0", "6", "2.5", "x", "", " ", -1, 1.5]) {
      expect(readInteger(value, { min: 1, max: 5 }), String(value)).toBe(
        undefined
      );
    }
  });

  it("reads a name list trimmed, each once, no templates; empty means all", () => {
    expect(readNameList([" titan", "titan", "quasar"], 16)).toEqual([
      "titan",
      "quasar",
    ]);
    expect(readNameList('["titan"]', 16)).toEqual(["titan"]);
    expect(readNameList([], 16)).toBeUndefined();
    for (const bad of ["titan", [""], [1], ["{{@n:N.name}}"], ["a", "b"]]) {
      expect(readNameList(bad, 1), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("bundleLoopRefusal", () => {
  it("allows the top level and one For Each, not a nested one", () => {
    expect(bundleLoopRefusal(0)).toBeUndefined();
    expect(bundleLoopRefusal(1)).toBeUndefined();
    expect(bundleLoopRefusal(2)).toContain("inside another For Each");
  });
});

describe("step outcomes in run views", () => {
  const WRITE = "web3/write-contract";
  const step = (output: unknown, nodeType = WRITE, status = "success") => ({
    nodeId: "write",
    nodeType,
    status,
    output,
  });
  const missed = {
    route: "bundle",
    included: false,
    notIncludedReason: "not-checked",
  };

  it("reads a Write Contract step as the finalizer does", () => {
    expect(stepOutcomeOf(step(missed))).toBe("not-included");
    expect(stepOutcomeOf(step({ route: "skipped-in-flight" }))).toBe(
      "skipped-in-flight"
    );
    expect(stepOutcomeOf(step({ route: "bundle", included: true }))).toBe(
      undefined
    );
    expect(stepOutcomeOf(step(null))).toBeUndefined();
    expect(stepOutcomeOf(step(missed, WRITE, "error"))).toBeUndefined();
  });

  it("ignores the same keys on any other step, such as a webhook body", () => {
    for (const nodeType of ["Webhook", "Code", "web3/batch-write-contract"]) {
      expect(stepOutcomeOf(step(missed, nodeType))).toBeUndefined();
      expect(
        stepOutcomeOf(step({ route: "skipped-in-flight" }, nodeType))
      ).toBeUndefined();
    }
  });

  it("shows a missed step whose run re-settled as landed late", () => {
    const late = { status: "success", transactionHashes: [] };
    expect(stepOutcomeOf(step(missed), late)).toBe("landed-late");
    const mined = {
      status: "error",
      transactionHashes: [{ nodeId: "write", receiptStatus: "success" }],
    };
    expect(stepOutcomeOf(step(missed), mined)).toBe("landed-late");
    // A loop's other iteration, or another step, does not count.
    const other = {
      status: "not_landed",
      transactionHashes: [
        { nodeId: "write", iterationIndex: 1 },
        { nodeId: "other" },
      ],
    };
    expect(stepOutcomeOf({ ...step(missed), iterationIndex: 0 }, other)).toBe(
      "not-included"
    );
    expect(stepOutcomeOf({ ...step(missed), iterationIndex: 1 }, other)).toBe(
      "landed-late"
    );
    // A run that failed later keeps the miss.
    expect(
      stepOutcomeOf(step(missed), { status: "error", transactionHashes: [] })
    ).toBe("not-included");
  });

  it("shows a late landing that reverted as reverted, not landed", () => {
    const reverted = {
      status: "error",
      transactionHashes: [
        { nodeId: "write", iterationIndex: 0, receiptStatus: "reverted" },
      ],
    };
    expect(
      stepOutcomeOf({ ...step(missed), iterationIndex: 0 }, reverted)
    ).toBe("landed-late-reverted");
    // Another iteration's reverted landing leaves this one's miss.
    expect(
      stepOutcomeOf({ ...step(missed), iterationIndex: 1 }, reverted)
    ).toBe("not-included");
    // Two steps landed late in one run, one reverted: each shows its own.
    const mixed = {
      status: "error",
      transactionHashes: [
        { nodeId: "a", receiptStatus: "success" },
        { nodeId: "b", receiptStatus: "reverted" },
      ],
    };
    expect(stepOutcomeOf({ ...step(missed), nodeId: "a" }, mixed)).toBe(
      "landed-late"
    );
    expect(stepOutcomeOf({ ...step(missed), nodeId: "b" }, mixed)).toBe(
      "landed-late-reverted"
    );
    expect(
      canvasNodeStatus({ status: "success", outcome: "landed-late-reverted" })
    ).toBe("landed-late-reverted");
    expect(stepOutcomeTitle("landed-late-reverted")).toBe(
      "Reverted late: this step's bundle was not seen in its target blocks; its transaction was mined later, reverted, and still paid gas."
    );
  });

  it("builds every view's title from one map", () => {
    expect(stepOutcomeTitle("not-included", "Why.", undefined, "More.")).toBe(
      `${STEP_OUTCOME_TEXT["not-included"].label}: ${STEP_OUTCOME_TEXT["not-included"].sentence} Why. More.`
    );
  });

  it("says each reason in plain words", () => {
    expect(notIncludedReasonText({ notIncludedReason: "not-checked" })).toBe(
      "It could not be checked yet, and it may still land within about a day."
    );
    expect(
      notIncludedReasonText({ notIncludedReason: "not-picked" })
    ).toContain("no gas was paid");
    expect(notIncludedReasonText({ notIncludedReason: "other" })).toBe(
      undefined
    );
  });

  it("never draws a missed or skipped step green on the canvas", () => {
    expect(
      canvasNodeStatus({ status: "success", outcome: "not-included" })
    ).toBe("not-included");
    expect(
      canvasNodeStatus({ status: "success", outcome: "skipped-in-flight" })
    ).toBe("skipped");
    expect(
      canvasNodeStatus({ status: "success", outcome: "landed-late" })
    ).toBe("landed-late");
    expect(canvasNodeStatus({ status: "success" })).toBe("success");
    expect(canvasNodeStatus({ status: "cancelled" })).toBe("idle");
  });
});

describe("the Builders field (multi-select)", () => {
  const action = getIntegration("web3")?.actions.find(
    (entry) => entry.slug === "write-contract"
  );

  it("is an array of names in both MCP schemas", () => {
    if (!(action && getIntegration("web3"))) {
      throw new Error("Write Contract not registered");
    }
    const plugin = getIntegration("web3");
    const schema = transformPluginAction(
      plugin as NonNullable<typeof plugin>,
      action
    );
    expect(schema.optionalFields.bundleBuilders).toMatch(
      /^array of strings \(up to 16 names, duplicates are dropped, no templates\) - Builders/
    );
    const [pin] = preparePinDataForWorkflow([
      {
        id: "n",
        type: "action",
        data: { type: "action", config: { actionType: "web3/write-contract" } },
      },
    ]);
    expect(pin.pinSchema.properties.bundleBuilders).toMatchObject({
      type: "array",
      items: { type: "string" },
      maxItems: 16,
    });
    // Duplicates are dropped, not refused.
    expect(pin.pinSchema.properties.bundleBuilders).not.toHaveProperty(
      "uniqueItems"
    );
  });

  it("leaves the Builders value to the Send as check, so it gets one issue", () => {
    const issues = validateWorkflowActionConfigs([
      {
        id: "n",
        data: {
          type: "action",
          config: {
            actionType: "web3/write-contract",
            network: "1",
            sendMode: "bundle",
            contractAddress: "0x000000000000000000000000000000000000dEaD",
            abi: '[{"type":"function","name":"run","inputs":[],"outputs":[],"stateMutability":"nonpayable"}]',
            abiFunction: "run",
            bundleBuilders: ["{{@n:N.name}}"],
            bundleBlocks: "{{@n:N.blocks}}",
          },
        },
      },
    ]).issues.filter((issue) => issue.field?.startsWith("bundle"));
    expect(issues).toEqual([]);
  });
});
