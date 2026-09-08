import { describe, expect, it } from "vitest";
import {
  actionRequiredChainType,
  filterActionsByAvailableChainTypes,
} from "@/lib/workflow/action-chain-availability";
import type { ActionConfigField } from "@/plugins/registry";

function networkField(chainTypeFilter?: string): ActionConfigField {
  return {
    key: "network",
    label: "Network",
    type: "chain-select",
    ...(chainTypeFilter ? { chainTypeFilter } : {}),
  } as ActionConfigField;
}

const solanaAction = {
  id: "web3/transfer-spl-token",
  configFields: [networkField("solana")],
};
const evmAction = {
  id: "web3/transfer-token",
  configFields: [networkField("evm")],
};
const anyChainAction = {
  id: "web3/transfer-funds",
  configFields: [networkField()],
};
const noChainAction = {
  id: "discord/send-message",
  configFields: [
    { key: "text", label: "Text", type: "template-input" } as ActionConfigField,
  ],
};
const groupedSolana = {
  id: "web3/grouped",
  configFields: [
    {
      type: "group",
      label: "Advanced",
      fields: [networkField("solana")],
    } as ActionConfigField,
  ],
};

describe("actionRequiredChainType", () => {
  it("reads the chainTypeFilter from a top-level Network field", () => {
    expect(actionRequiredChainType(solanaAction.configFields)).toBe("solana");
    expect(actionRequiredChainType(evmAction.configFields)).toBe("evm");
  });

  it("returns undefined when the action has no chain-type requirement", () => {
    expect(
      actionRequiredChainType(anyChainAction.configFields)
    ).toBeUndefined();
    expect(actionRequiredChainType(noChainAction.configFields)).toBeUndefined();
    expect(actionRequiredChainType(undefined)).toBeUndefined();
  });

  it("finds the Network field nested inside a group", () => {
    expect(actionRequiredChainType(groupedSolana.configFields)).toBe("solana");
  });
});

describe("filterActionsByAvailableChainTypes", () => {
  it("hides Solana-only actions when no Solana chain is enabled", () => {
    const result = filterActionsByAvailableChainTypes(
      [solanaAction, evmAction, noChainAction],
      new Set(["evm"])
    );
    expect(result.map((a) => a.id)).toEqual([evmAction.id, noChainAction.id]);
  });

  it("keeps Solana actions when a Solana chain is enabled", () => {
    const result = filterActionsByAvailableChainTypes(
      [solanaAction, evmAction],
      new Set(["evm", "solana"])
    );
    expect(result.map((a) => a.id)).toEqual([solanaAction.id, evmAction.id]);
  });

  it("always keeps actions with no chain-type requirement", () => {
    const result = filterActionsByAvailableChainTypes(
      [noChainAction, anyChainAction],
      new Set()
    );
    expect(result.map((a) => a.id)).toEqual([
      noChainAction.id,
      anyChainAction.id,
    ]);
  });
});
