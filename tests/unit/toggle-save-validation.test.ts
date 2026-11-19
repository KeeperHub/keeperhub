// On/off toggles have no template mode in the editor. A template or stray text
// in one would let the data it reads turn gas sponsorship or fail-on-error
// off, so a save holding anything but true or false is refused.

import { describe, expect, it } from "vitest";
import {
  SYSTEM_ACTIONS,
  systemActionToggleKeys,
} from "@/lib/mcp/workflow-schema-constants";
import {
  formatActionConfigValidationResponse,
  validateWorkflowActionConfigs,
} from "@/lib/workflow/validation/action-config";
import {
  computeActionId,
  findActionById,
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

describe("system action toggles at save", () => {
  it("takes them from the boolean inputs in SYSTEM_ACTIONS", () => {
    expect(systemActionToggleKeys("HTTP Request")).toEqual(["failOnError"]);
    expect(systemActionToggleKeys("Condition")).toEqual([]);
    expect(systemActionToggleKeys("Not an action")).toEqual([]);
  });

  it("refuses a template in every one of them", () => {
    const keys = Object.values(SYSTEM_ACTIONS).flatMap((action) =>
      systemActionToggleKeys(action.actionType).map((key) => ({
        actionType: action.actionType,
        key,
      }))
    );
    expect(keys.length).toBeGreaterThan(0);
    for (const { actionType, key } of keys) {
      expect(issuesAt(actionType, key, TEMPLATE)).toMatchObject([
        { code: "INVALID_FIELD_TYPE", field: key },
      ]);
    }
  });
});

describe("a stray toggle value already saved", () => {
  const FILTER_CONFIG = { source: "[1]", operator: "===", value: "1" };

  function savedAs(config: Record<string, unknown>) {
    return [actionNode(WRITE_CONTRACT, { ...WRITE_CONFIG, ...config })];
  }

  function save(
    config: Record<string, unknown>,
    savedNodes: unknown[],
    actionType = WRITE_CONTRACT,
    base: Record<string, unknown> = WRITE_CONFIG
  ) {
    return validateWorkflowActionConfigs(
      [actionNode(actionType, { ...base, ...config })],
      { savedNodes }
    );
  }

  it("still saves while it is unchanged", () => {
    for (const value of [TEMPLATE, "on", 1, { flag: true }, [1]]) {
      expect(
        // A copy, as a stored workflow is parsed from JSON.
        save(
          { sponsorGas: value },
          savedAs({ sponsorGas: structuredClone(value) })
        ),
        String(value)
      ).toEqual({ valid: true, issues: [] });
    }
  });

  it("is refused once it changes, or when it is new", () => {
    const cases: [unknown, unknown[]][] = [
      [TEMPLATE, savedAs({ sponsorGas: `${TEMPLATE} ` })],
      [TEMPLATE, savedAs({ sponsorGas: true })],
      [TEMPLATE, savedAs({})],
      [TEMPLATE, []],
      [{ flag: true }, savedAs({ sponsorGas: { flag: false } })],
    ];
    for (const [value, savedNodes] of cases) {
      expect(save({ sponsorGas: value }, savedNodes).issues).toMatchObject([
        { field: "sponsorGas" },
      ]);
    }
  });

  it("is matched by node id, not by position", () => {
    const other = { ...savedAs({ sponsorGas: TEMPLATE })[0], id: "node-2" };
    expect(save({ sponsorGas: TEMPLATE }, [other]).issues).toMatchObject([
      { field: "sponsorGas" },
    ]);
  });

  it("covers HTTP Request's failOnError and a plain switch", () => {
    const http = [actionNode("HTTP Request", { failOnError: TEMPLATE })];
    expect(
      issuesAt("HTTP Request", "failOnError", TEMPLATE).length
    ).toBeGreaterThan(0);
    expect(
      validateWorkflowActionConfigs(http, { savedNodes: http }).issues.filter(
        (issue) => issue.field === "failOnError"
      )
    ).toEqual([]);

    const filter = [
      actionNode("data/filter", { ...FILTER_CONFIG, ignoreCase: TEMPLATE }),
    ];
    const ignoreCase = (savedNodes: unknown[]) =>
      validateWorkflowActionConfigs(filter, { savedNodes }).issues.filter(
        (issue) => issue.field === "ignoreCase"
      );
    expect(ignoreCase([])).toHaveLength(1);
    expect(ignoreCase(filter)).toEqual([]);
  });
});

describe("which toggles are checked", () => {
  it("checks a plain switch only while its condition shows it", () => {
    const ignoreCase = (operator: string) =>
      validateWorkflowActionConfigs([
        actionNode("data/filter", {
          source: "[1]",
          operator,
          value: "1",
          ignoreCase: TEMPLATE,
        }),
      ]).issues.filter((issue) => issue.field === "ignoreCase");
    expect(ignoreCase("===")).toHaveLength(1);
    expect(ignoreCase("isEmpty")).toEqual([]);
  });

  it("skips a hidden toggle, which the form could never show to fix", () => {
    const field = flattenConfigFields(
      findActionById(WRITE_CONTRACT)?.configFields ?? []
    ).find((candidate) => candidate.key === "sponsorGas");
    expect(field).toBeDefined();
    if (!field) {
      return;
    }
    field.hidden = true;
    try {
      expect(issuesAt(WRITE_CONTRACT, "sponsorGas", TEMPLATE)).toEqual([]);
    } finally {
      field.hidden = undefined;
    }
    expect(issuesAt(WRITE_CONTRACT, "sponsorGas", TEMPLATE)).toHaveLength(1);
  });
});
