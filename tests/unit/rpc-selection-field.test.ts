import { describe, expect, it } from "vitest";

import { transformPluginAction } from "@/lib/action-schemas/builder";
import { RPC_SELECTION_CONFIG_KEY } from "@/lib/rpc/engine/scope";
import { RpcSelectionMode } from "@/lib/rpc/engine/types";
import {
  ADVANCED_GROUP_LABEL,
  actionRpcNetworkKey,
  RPC_SELECTION_FIELD_TYPE,
  RPC_SELECTION_TYPE_TEXT,
  withRpcSelectionField,
} from "@/lib/workflow/rpc-selection-field";
import { validateWorkflowActionConfigs } from "@/lib/workflow/validation/action-config";
import {
  type ActionConfigField,
  buildExampleConfig,
  findActionById,
  flattenConfigFields,
  getAllIntegrations,
  getIntegration,
  isFieldGroup,
} from "@/plugins/registry";

const CHECK_BALANCE = "web3/check-balance";
const TRANSFER_FUNDS = "web3/transfer-funds";
const RUN_CODE = "code/run-code";

function rpcFieldsOf(fields: readonly ActionConfigField[]) {
  return flattenConfigFields([...fields]).filter(
    (field) => field.type === RPC_SELECTION_FIELD_TYPE
  );
}

function advancedGroupOf(fields: readonly ActionConfigField[]) {
  return fields.filter(
    (field) => isFieldGroup(field) && field.label === ADVANCED_GROUP_LABEL
  );
}

function configFieldsOf(actionType: string): ActionConfigField[] {
  const action = findActionById(actionType);
  if (!action) {
    throw new Error(`no action ${actionType}`);
  }
  return action.configFields;
}

describe("withRpcSelectionField", () => {
  const network: ActionConfigField = {
    key: "chain",
    label: "Network",
    type: "chain-select",
  };

  it("adds an Advanced group when there is none", () => {
    const fields = withRpcSelectionField([network]);
    const [group] = advancedGroupOf(fields);
    expect(group).toBeDefined();
    expect(rpcFieldsOf(fields)).toEqual([
      expect.objectContaining({
        key: RPC_SELECTION_CONFIG_KEY,
        defaultValue: RpcSelectionMode.AUTO,
        networkField: "chain",
      }),
    ]);
    expect(rpcFieldsOf(fields)[0].required).toBeFalsy();
  });

  it("joins an existing Advanced group", () => {
    const fields = withRpcSelectionField([
      network,
      {
        type: "group",
        label: ADVANCED_GROUP_LABEL,
        fields: [{ key: "gas", label: "Gas", type: "text" }],
      },
    ]);
    const groups = advancedGroupOf(fields);
    expect(groups).toHaveLength(1);
    const [group] = groups;
    expect(isFieldGroup(group) && group.fields.map((f) => f.key)).toEqual([
      "gas",
      RPC_SELECTION_CONFIG_KEY,
    ]);
  });

  it("adds the selector once", () => {
    const once = withRpcSelectionField([network]);
    expect(withRpcSelectionField(once)).toBe(once);
  });

  it("leaves a network picker that does not choose RPC endpoints alone", () => {
    const explorer: ActionConfigField = { ...network, rpcRouted: false };
    expect(withRpcSelectionField([explorer])).toEqual([explorer]);
    expect(actionRpcNetworkKey([explorer])).toBeNull();
    expect(actionRpcNetworkKey([network])).toBe(network.key);
  });

  it("leaves fields without a network picker alone", () => {
    const fields: ActionConfigField[] = [
      { key: "url", label: "URL", type: "text" },
    ];
    expect(withRpcSelectionField(fields)).toBe(fields);
  });
});

describe("registered actions", () => {
  it("gives every chain-select action exactly one selector, in Advanced", () => {
    for (const plugin of getAllIntegrations()) {
      for (const action of plugin.actions) {
        const flat = flattenConfigFields(action.configFields);
        const hasChain = flat.some(
          (field) => field.type === "chain-select" && field.rpcRouted !== false
        );
        const rpc = rpcFieldsOf(action.configFields);
        expect(rpc).toHaveLength(hasChain ? 1 : 0);
        if (hasChain) {
          const [group] = advancedGroupOf(action.configFields);
          expect(
            isFieldGroup(group) &&
              group.fields.some((f) => f.type === RPC_SELECTION_FIELD_TYPE)
          ).toBe(true);
        }
      }
    }
  });

  it("creates the Advanced group for an action that had none", () => {
    expect(advancedGroupOf(configFieldsOf(CHECK_BALANCE))).toHaveLength(1);
  });

  it("keeps a single Advanced group on an action that had one", () => {
    const fields = configFieldsOf(TRANSFER_FUNDS);
    expect(advancedGroupOf(fields)).toHaveLength(1);
    expect(rpcFieldsOf(fields)).toHaveLength(1);
  });

  it("does not add the selector to explorer-only Blockscout actions", () => {
    const blockscout = getIntegration("blockscout");
    expect(blockscout?.actions.length).toBeGreaterThan(0);
    for (const action of blockscout?.actions ?? []) {
      expect(rpcFieldsOf(action.configFields)).toHaveLength(0);
    }
  });

  it("does not add the selector to an action without a network", () => {
    expect(rpcFieldsOf(configFieldsOf(RUN_CODE))).toHaveLength(0);
  });
});

describe("rpc-config-select in schemas and prompts", () => {
  it("describes the selector as auto, platform or a config id", () => {
    const plugin = getIntegration("web3");
    const action = plugin?.actions.find((a) => a.slug === "check-balance");
    if (!(plugin && action)) {
      throw new Error("web3/check-balance is not registered");
    }
    const schema = transformPluginAction(plugin, action);
    expect(schema.requiredFields[RPC_SELECTION_CONFIG_KEY]).toBeUndefined();
    expect(schema.optionalFields[RPC_SELECTION_CONFIG_KEY]).toContain(
      RPC_SELECTION_TYPE_TEXT
    );
  });

  it("seeds the AI example with auto, not placeholder text", () => {
    const example = buildExampleConfig(
      CHECK_BALANCE,
      configFieldsOf(CHECK_BALANCE)
    );
    expect(example[RPC_SELECTION_CONFIG_KEY]).toBe(RpcSelectionMode.AUTO);
  });
});

describe("rpc-config-select save validation", () => {
  function nodeWith(value: unknown) {
    return {
      id: "node-1",
      type: "action",
      data: {
        type: "action",
        label: "Balance",
        config: {
          actionType: CHECK_BALANCE,
          network: "1",
          address: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
          [RPC_SELECTION_CONFIG_KEY]: value,
        },
      },
    };
  }

  it.each([RpcSelectionMode.AUTO, RpcSelectionMode.PLATFORM, "cfg_123", ""])(
    "accepts %j",
    (value) => {
      expect(validateWorkflowActionConfigs([nodeWith(value)]).valid).toBe(true);
    }
  );

  it.each([42, "{{@n1:Step.id}}"])("refuses %j", (value) => {
    const result = validateWorkflowActionConfigs([nodeWith(value)]);
    expect(result.valid).toBe(false);
    expect(result.issues[0]?.path).toContain(RPC_SELECTION_CONFIG_KEY);
  });
});
