import { describe, expect, it } from "vitest";
import { buildConfigForActionTypeChange } from "@/lib/workflow/editor/action-type-transition";
import { validateWorkflowActionConfigs } from "@/lib/workflow/validation/action-config";
import { findActionById, flattenConfigFields } from "@/plugins/registry";

const READ_CONTRACT_ABI = JSON.stringify([
  {
    type: "function",
    name: "reader",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
]);

function defaultsForAction(actionType: string): Record<string, unknown> {
  const action = findActionById(actionType);
  const defaults: Record<string, unknown> = {};
  if (!action?.configFields) {
    return defaults;
  }
  for (const field of flattenConfigFields(action.configFields)) {
    if (field.defaultValue !== undefined) {
      defaults[field.key] = field.defaultValue;
    }
  }
  return defaults;
}

describe("buildConfigForActionTypeChange", () => {
  it("drops leftover fields from the previous action type", () => {
    const previous = {
      actionType: "discord/send-message",
      network: "1",
      contractAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
      abi: READ_CONTRACT_ABI,
      abiFunction: "reader",
    };

    const next = buildConfigForActionTypeChange(
      "discord/send-message",
      previous
    );

    expect(next.network).toBeUndefined();
    expect(next.contractAddress).toBeUndefined();
    expect(next.abi).toBeUndefined();
    expect(next.abiFunction).toBeUndefined();
    expect(next.actionType).toBe("discord/send-message");
  });

  it("preserves fields the target action shares with the previous one", () => {
    const previous = {
      actionType: "web3/write-contract",
      network: "8453",
      contractAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
      abi: READ_CONTRACT_ABI,
      abiFunction: "reader",
    };

    const next = buildConfigForActionTypeChange(
      "web3/write-contract",
      previous
    );

    expect(next.network).toBe("8453");
    expect(next.contractAddress).toBe(
      "0x6B175474E89094C44Da98b954EedeAC495271d0F"
    );
    expect(next.abi).toBe(READ_CONTRACT_ABI);
    expect(next.abiFunction).toBe("reader");
  });

  it("always drops integrationId since it is re-selected per action", () => {
    const next = buildConfigForActionTypeChange("web3/write-contract", {
      actionType: "web3/write-contract",
      integrationId: "abc-123",
      network: "1",
    });

    expect(next.integrationId).toBeUndefined();
    expect(next.network).toBe("1");
  });

  it("seeds the target action's field defaults when missing", () => {
    const defaults = defaultsForAction("aave-v3/supply");
    // Guards against the action losing its defaults and the test going vacuous.
    expect(Object.keys(defaults)).toContain("referralCode");

    const next = buildConfigForActionTypeChange("aave-v3/supply", {
      actionType: "aave-v3/supply",
    });

    for (const [key, value] of Object.entries(defaults)) {
      expect(next[key]).toEqual(value);
    }
  });

  it("does not overwrite an existing value with the field default", () => {
    // blockscout/get-address-balance defaults network to "1"; a user choice
    // of a different network must survive the transition.
    const next = buildConfigForActionTypeChange(
      "blockscout/get-address-balance",
      {
        actionType: "blockscout/get-address-balance",
        network: "8453",
      }
    );

    expect(next.network).toBe("8453");
  });

  it("force-refreshes _protocolMeta to the target action on protocol switch", () => {
    const borrowMeta = defaultsForAction("aave-v3/borrow")._protocolMeta;
    const withdrawMeta = defaultsForAction("aave-v3/withdraw")._protocolMeta;
    expect(borrowMeta).toBeDefined();
    expect(withdrawMeta).toBeDefined();
    expect(borrowMeta).not.toEqual(withdrawMeta);

    // Node currently holds borrow's metadata; switching to withdraw must
    // overwrite it so the runtime calls the right contract function.
    const next = buildConfigForActionTypeChange("aave-v3/withdraw", {
      actionType: "aave-v3/withdraw",
      _protocolMeta: borrowMeta,
    });

    expect(next._protocolMeta).toEqual(withdrawMeta);
  });

  it("leaves config untouched (minus integrationId) for unknown action types", () => {
    const next = buildConfigForActionTypeChange("not-a-real/action", {
      actionType: "not-a-real/action",
      integrationId: "keep-out",
      someLeftover: "kept",
    });

    expect(next.someLeftover).toBe("kept");
    expect(next.integrationId).toBeUndefined();
  });

  it("produces a config that passes validation with no UNKNOWN_FIELD errors", () => {
    // Switching from a fully-configured read-contract to write-contract: the
    // shared address/abi survive, the leftover-free result must not raise
    // UNKNOWN_FIELD or INVALID_FIELD_TYPE for keys carried over from before.
    const config = buildConfigForActionTypeChange("web3/write-contract", {
      actionType: "web3/write-contract",
      network: "1",
      contractAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
      abi: READ_CONTRACT_ABI,
      abiFunction: "reader",
      // a stale key from a non-web3 action that must be pruned
      discordMessage: "leftover",
    });

    const result = validateWorkflowActionConfigs([
      { type: "action", data: { type: "action", config } },
    ]);

    const carryoverIssues = result.issues.filter(
      (issue) =>
        issue.code === "UNKNOWN_FIELD" || issue.code === "INVALID_FIELD_TYPE"
    );
    expect(carryoverIssues).toEqual([]);
    expect(config.discordMessage).toBeUndefined();
  });
});
