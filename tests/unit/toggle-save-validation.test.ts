// On/off toggles have no template mode in the editor. A template or stray text
// in one would let the data it reads turn gas sponsorship or fail-on-error
// off, so a save holding anything but true or false is refused.

import { describe, expect, it } from "vitest";
import {
  formatActionConfigValidationResponse,
  validateWorkflowActionConfigs,
} from "@/lib/workflow/validation/action-config";
import {
  computeActionId,
  flattenConfigFields,
  getAllIntegrations,
  isDefaultOnToggleField,
} from "@/plugins/registry";

const TEMPLATE = "{{@webhook:Webhook.flag}}";
const ACCEPTED: unknown[] = [true, false, "true", "false", undefined, null, ""];
const REFUSED: unknown[] = [
  TEMPLATE,
  `true${TEMPLATE}`,
  "maybe",
  "on",
  "1",
  1,
  0,
];

const WRITE_CONTRACT = "web3/write-contract";
const WRITE_CONFIG = {
  network: "1",
  contractAddress: "0x00000000000000000000000000000000000000aB",
  abi: '[{"type":"function","name":"poke","inputs":[],"outputs":[],"stateMutability":"nonpayable"}]',
  abiFunction: "poke",
};

function actionNode(actionType: string, config: Record<string, unknown>) {
  return {
    id: "node-1",
    type: "action",
    data: {
      label: "My step",
      type: "action",
      config: { actionType, ...config },
    },
  };
}

function issuesAt(actionType: string, key: string, value: unknown) {
  const result = validateWorkflowActionConfigs([
    actionNode(actionType, { [key]: value }),
  ]);
  return result.issues.filter(
    (issue) => issue.path === `nodes[0].data.config.${key}`
  );
}

const defaultOnToggles = getAllIntegrations().flatMap((integration) =>
  integration.actions.flatMap((action) =>
    flattenConfigFields(action.configFields)
      .filter((field) => isDefaultOnToggleField(field.type))
      .map((field) => ({
        actionType: computeActionId(integration.type, action.slug),
        key: field.key,
        type: field.type,
      }))
  )
);

describe("toggle fields at save", () => {
  it("finds the toggles it sweeps", () => {
    const types = new Set(defaultOnToggles.map((toggle) => toggle.type));
    expect(types).toEqual(
      new Set(["fail-on-error-switch", "gas-sponsorship-switch"])
    );
  });

  it("accepts true, false and an unset value on every default-on toggle", () => {
    for (const { actionType, key } of defaultOnToggles) {
      for (const value of ACCEPTED) {
        expect(
          issuesAt(actionType, key, value),
          `${actionType}.${key} = ${String(value)}`
        ).toEqual([]);
      }
    }
  });

  it("refuses a template or other text on every default-on toggle", () => {
    for (const { actionType, key } of defaultOnToggles) {
      for (const value of REFUSED) {
        expect(
          issuesAt(actionType, key, value),
          `${actionType}.${key} = ${String(value)}`
        ).toMatchObject([
          {
            code: "INVALID_FIELD_TYPE",
            field: key,
            expected: "boolean",
            received: value,
          },
        ]);
      }
    }
  });

  it("saves a complete Write Contract with the toggle on or off", () => {
    for (const sponsorGas of [true, false]) {
      expect(
        validateWorkflowActionConfigs([
          actionNode(WRITE_CONTRACT, { ...WRITE_CONFIG, sponsorGas }),
        ])
      ).toEqual({ valid: true, issues: [] });
    }
  });

  it("refuses it with a template and says which field and what to enter", () => {
    const result = validateWorkflowActionConfigs([
      actionNode(WRITE_CONTRACT, { ...WRITE_CONFIG, sponsorGas: TEMPLATE }),
    ]);
    expect(result.issues).toMatchObject([
      {
        message: `Field "sponsorGas" on action "${WRITE_CONTRACT}" is an on/off toggle: set it to true or false, or remove it for the default; anything else, a template included, is refused.`,
      },
    ]);
    expect(formatActionConfigValidationResponse(result).message).toBe(
      'Workflow contains invalid action configuration. Invalid node(s): "My step" (sponsorGas). Fix the listed fields and save again.'
    );
  });

  it("checks Sponsor gas even when a templated network hides it", () => {
    const result = validateWorkflowActionConfigs([
      actionNode(WRITE_CONTRACT, {
        ...WRITE_CONFIG,
        network: "{{@trigger:Trigger.chain}}",
        sponsorGas: TEMPLATE,
      }),
    ]);
    expect(result.issues).toMatchObject([{ field: "sponsorGas" }]);
  });
});

describe("HTTP Request failOnError at save", () => {
  it("accepts true, false and an unset value", () => {
    for (const value of ACCEPTED) {
      expect(issuesAt("HTTP Request", "failOnError", value)).toEqual([]);
    }
  });

  it("refuses a template or other text", () => {
    for (const value of REFUSED) {
      expect(
        issuesAt("HTTP Request", "failOnError", value),
        String(value)
      ).toMatchObject([
        {
          code: "INVALID_FIELD_TYPE",
          field: "failOnError",
          nodeId: "node-1",
          nodeLabel: "My step",
          received: value,
        },
      ]);
    }
  });
});

describe("plain switch at save", () => {
  it("refuses a template in Filter Array's Ignore case", () => {
    const issues = validateWorkflowActionConfigs([
      actionNode("data/filter", {
        source: "[1]",
        operator: "===",
        value: "1",
        ignoreCase: TEMPLATE,
      }),
    ]).issues.filter((issue) => issue.field === "ignoreCase");
    expect(issues).toMatchObject([{ code: "INVALID_FIELD_VALUE" }]);
  });
});
