// On/off toggles have no template mode in the editor. A template or stray text
// in one would let the data it reads turn gas sponsorship or fail-on-error
// off, so a save holding anything but true or false is refused.

import { describe, expect, it } from "vitest";
import {
  SYSTEM_ACTIONS,
  systemActionToggleKeys,
} from "@/lib/mcp/workflow-schema-constants";
import {
  clearStrayToggles,
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
// The trigger TEMPLATE reads, for saves that keep a stored value.
const WEBHOOK = {
  id: "webhook",
  type: "trigger",
  data: {
    label: "Webhook",
    type: "trigger",
    config: { triggerType: "Webhook" },
  },
};
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
            code: "INVALID_FIELD_VALUE",
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
        message: "Sponsor gas does not take a template, only true or false.",
      },
    ]);
    expect(formatActionConfigValidationResponse(result).message).toBe(
      'Workflow contains invalid action configuration. Invalid node(s): "My step": Sponsor gas does not take a template, only true or false. Fix the listed fields and save again.'
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
          code: "INVALID_FIELD_VALUE",
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

describe("a near miss in a default-on toggle", () => {
  it("says what to change, as a plain switch does", () => {
    expect(issuesAt("HTTP Request", "failOnError", " TRUE")).toMatchObject([
      {
        message:
          "failOnError must be true or false, with no spaces around it and in lowercase.",
      },
    ]);
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
        { code: "INVALID_FIELD_VALUE", field: key },
      ]);
    }
  });
});

describe("a stray toggle value already saved", () => {
  const FILTER_CONFIG = { source: "[1]", operator: "===", value: "1" };

  function savedAs(config: Record<string, unknown>) {
    return [
      WEBHOOK,
      actionNode(WRITE_CONTRACT, { ...WRITE_CONFIG, ...config }),
    ];
  }

  function save(
    config: Record<string, unknown>,
    savedNodes: unknown[],
    actionType = WRITE_CONTRACT,
    base: Record<string, unknown> = WRITE_CONFIG
  ) {
    return validateWorkflowActionConfigs(
      [WEBHOOK, actionNode(actionType, { ...base, ...config })],
      { savedNodes }
    );
  }

  it("still saves while it is unchanged", () => {
    for (const value of [TEMPLATE, "on", 1]) {
      expect(
        save({ sponsorGas: value }, savedAs({ sponsorGas: value })),
        String(value)
      ).toEqual({ valid: true, issues: [] });
    }
  });

  it("never keeps a list or object, even an equal one", () => {
    for (const value of [{ flag: true }, [1]]) {
      expect(
        save(
          { sponsorGas: value },
          savedAs({ sponsorGas: structuredClone(value) })
        ).issues
      ).toMatchObject([{ field: "sponsorGas" }]);
    }
  });

  it("is kept when the node it reads from was renamed", () => {
    const trigger = (label: string) => ({
      id: "hook",
      type: "trigger",
      data: { label, type: "trigger", config: {} },
    });
    const ref = (label: string) => `{{@hook:${label}.body.flag}}`;
    const stored = [trigger("Old"), ...savedAs({ sponsorGas: ref("Old") })];
    const renamed = (value: string, label = "New") =>
      validateWorkflowActionConfigs(
        [
          trigger(label),
          actionNode(WRITE_CONTRACT, { ...WRITE_CONFIG, sponsorGas: value }),
        ],
        { savedNodes: stored }
      ).issues;
    expect(renamed(ref("New"))).toEqual([]);
    // The step reads the path after the first dot, so this reads "x.body.flag".
    expect(renamed(ref("New.x"), "New.x")).toMatchObject([
      { field: "sponsorGas" },
    ]);
    expect(renamed("{{@hook:New.body.other}}")).toMatchObject([
      { field: "sponsorGas" },
    ]);
    expect(renamed("{{@other:New.body.flag}}")).toMatchObject([
      { field: "sponsorGas" },
    ]);
  });

  it("is not kept when the node changes action or its id is sent twice", () => {
    const http = [actionNode("HTTP Request", { failOnError: TEMPLATE })];
    const asCondition = [actionNode("Condition", { failOnError: TEMPLATE })];
    expect(
      validateWorkflowActionConfigs(http, { savedNodes: asCondition }).issues
    ).toMatchObject([{ field: "failOnError" }]);
    expect(
      validateWorkflowActionConfigs([...http, ...http], { savedNodes: http })
        .issues
    ).toMatchObject([{ field: "failOnError" }, { field: "failOnError" }]);
  });

  it("is refused once it changes, or when it is new", () => {
    const cases: [unknown, unknown[]][] = [
      [TEMPLATE, savedAs({ sponsorGas: `${TEMPLATE} ` })],
      [TEMPLATE, savedAs({ sponsorGas: true })],
      [TEMPLATE, savedAs({})],
      [TEMPLATE, []],
      [2, savedAs({ sponsorGas: 1 })],
      ["5", savedAs({ sponsorGas: 5 })],
      [`y${TEMPLATE}`, savedAs({ sponsorGas: `x${TEMPLATE}` })],
      ["{{Other.x}}", savedAs({ sponsorGas: "{{Webhook.flag}}" })],
    ];
    for (const [value, savedNodes] of cases) {
      expect(save({ sponsorGas: value }, savedNodes).issues).toMatchObject([
        { field: "sponsorGas" },
      ]);
    }
  });

  it("is matched by node id, not by position", () => {
    const other = { ...savedAs({ sponsorGas: TEMPLATE })[1], id: "node-2" };
    expect(
      save({ sponsorGas: TEMPLATE }, [WEBHOOK, other]).issues
    ).toMatchObject([{ field: "sponsorGas" }]);
  });

  it("covers HTTP Request's failOnError and a plain switch", () => {
    const http = [
      WEBHOOK,
      actionNode("HTTP Request", { failOnError: TEMPLATE }),
    ];
    expect(
      issuesAt("HTTP Request", "failOnError", TEMPLATE).length
    ).toBeGreaterThan(0);
    expect(
      validateWorkflowActionConfigs(http, { savedNodes: http }).issues.filter(
        (issue) => issue.field === "failOnError"
      )
    ).toEqual([]);

    const filter = [
      WEBHOOK,
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

describe("clearStrayToggles", () => {
  it("unsets only toggles holding neither on nor off", () => {
    const [write, http, filter] = clearStrayToggles([
      actionNode(WRITE_CONTRACT, {
        ...WRITE_CONFIG,
        sponsorGas: TEMPLATE,
        failOnError: false,
      }),
      actionNode("HTTP Request", { failOnError: "on", endpoint: "x" }),
      actionNode("data/filter", { ignoreCase: TEMPLATE, value: TEMPLATE }),
    ]).map((node) => (node.data as { config: Record<string, unknown> }).config);
    expect(write).not.toHaveProperty("sponsorGas");
    expect(write.failOnError).toBe(false);
    expect(write.abiFunction).toBe("poke");
    expect(http).not.toHaveProperty("failOnError");
    expect(http.endpoint).toBe("x");
    expect(filter).not.toHaveProperty("ignoreCase");
    expect(filter.value).toBe(TEMPLATE);
  });
});

describe("toggle declarations", () => {
  it("has no hidden default-on toggle, which save would not check", () => {
    const hidden = getAllIntegrations().flatMap((integration) =>
      integration.actions.flatMap((action) =>
        flattenConfigFields(action.configFields).filter(
          (field) => isDefaultOnToggleField(field.type) && field.hidden
        )
      )
    );
    expect(hidden).toEqual([]);
  });

  it("finds every system action input described as a boolean", () => {
    for (const action of Object.values(SYSTEM_ACTIONS)) {
      const inputs: Record<string, string> = {
        ...action.requiredFields,
        ...("optionalFields" in action ? action.optionalFields : {}),
      };
      const looksBoolean = Object.entries(inputs)
        .filter(([, description]) => /^\s*boolean\b/i.test(description))
        .map(([key]) => key);
      expect(
        systemActionToggleKeys(action.actionType),
        action.actionType
      ).toEqual(looksBoolean);
    }
  });
});

describe("which stored stray value counts as kept", () => {
  const trigger = (id: string, label: string) => ({
    id,
    type: "trigger",
    data: { label, type: "trigger", config: { triggerType: "Webhook" } },
  });
  const hook = trigger("hook", "Webhook");
  const write = (sponsorGas: unknown) =>
    actionNode(WRITE_CONTRACT, { ...WRITE_CONFIG, sponsorGas });
  const issues = (nodes: unknown[], savedNodes: unknown[]) =>
    validateWorkflowActionConfigs(
      nodes as Parameters<typeof validateWorkflowActionConfigs>[0],
      { savedNodes }
    ).issues.filter((issue) => issue.field === "sponsorGas");
  const REF = "{{@hook:Webhook.body.flag}}";

  it("never takes literal text for a reference", () => {
    // No colon, so the step reads it as text, not as webhook data.
    expect(
      issues([hook, write(REF)], [hook, write("{{@hook.body.flag}}")])
    ).toHaveLength(1);
  });

  it("tells a dotted node id from a field path", () => {
    const nodes = [trigger("a", "L"), trigger("a.b", "L")];
    expect(
      issues(
        [...nodes, write("{{@a:L.b.flag}}")],
        [...nodes, write("{{@a.b:L.flag}}")]
      )
    ).toHaveLength(1);
  });

  it("refuses it once a node it reads is added or replaced", () => {
    expect(issues([hook, write(REF)], [write(REF)])).toHaveLength(1);
    const asStep = actionNode(WRITE_CONTRACT, WRITE_CONFIG);
    const replaced = { ...asStep, id: "hook" };
    expect(issues([hook, write(REF)], [replaced, write(REF)])).toHaveLength(1);
  });

  it("keeps it when a node it reads was deleted", () => {
    expect(issues([write(REF)], [hook, write(REF)])).toEqual([]);
  });

  it("keeps a plain switch only if it was shown when saved", () => {
    const filter = (operator: string) =>
      actionNode("data/filter", {
        source: "[1]",
        operator,
        value: "1",
        ignoreCase: REF,
      });
    const ignoreCase = (savedOperator: string) =>
      validateWorkflowActionConfigs([hook, filter("===")], {
        savedNodes: [hook, filter(savedOperator)],
      }).issues.filter((issue) => issue.field === "ignoreCase");
    expect(ignoreCase("===")).toEqual([]);
    expect(ignoreCase("isEmpty")).toHaveLength(1);
  });
});

describe("a kept value matches what the step resolves", () => {
  const node = (id: string, kind: "trigger" | "action", label = "N") => ({
    id,
    type: kind,
    data: {
      label,
      type: kind,
      config:
        kind === "trigger"
          ? { triggerType: "Webhook" }
          : { actionType: "HTTP Request" },
    },
  });
  const write = (sponsorGas: string) =>
    actionNode(WRITE_CONTRACT, { ...WRITE_CONFIG, sponsorGas });
  const issues = (nodes: unknown[], savedNodes: unknown[]) =>
    validateWorkflowActionConfigs(
      nodes as Parameters<typeof validateWorkflowActionConfigs>[0],
      { savedNodes }
    ).issues.filter((issue) => issue.field === "sponsorGas");

  it("never keeps a reference by label, which the step resolves by name", () => {
    const value = "{{Check.flag}}";
    expect(issues([write(value)], [write(value)])).toHaveLength(1);
    expect(
      issues([write("{{ @hook:H.flag }}")], [write("{{ @hook:H.flag }}")])
    ).toHaveLength(1);
  });

  it("reads node ids as the step does, trimmed with symbols as _", () => {
    const value = "{{@a-b:R.flag}}";
    expect(
      issues(
        [node("a_b", "trigger"), write(value)],
        [node("a-b", "action"), write(value)]
      )
    ).toHaveLength(1);
    const spaced = "{{@ t:T.flag}}";
    expect(
      issues(
        [node("t", "trigger"), write(spaced)],
        [node("t", "action"), write(spaced)]
      )
    ).toHaveLength(1);
  });

  it("tells a trigger by its trigger type", () => {
    const value = "{{@t:T.flag}}";
    const asTrigger = (triggerType: string) => ({
      id: "t",
      type: "trigger",
      data: {
        label: "T",
        type: "trigger",
        config: { triggerType, actionType: "x" },
      },
    });
    expect(
      issues(
        [asTrigger("Webhook"), write(value)],
        [asTrigger("Manual"), write(value)]
      )
    ).toHaveLength(1);
  });

  it("never keeps a very long value", () => {
    const value = `{{@hook:H.flag}}${"x".repeat(2000)}`;
    expect(
      issues(
        [node("hook", "trigger"), write(value)],
        [node("hook", "trigger"), write(value)]
      )
    ).toHaveLength(1);
  });
});

describe("a kept value and the nodes it reads", () => {
  const step = (actionType: string) => ({
    id: "step1",
    type: "action",
    data: { label: "S", type: "action", config: { actionType } },
  });
  const value = "{{@step1:S.result}}";
  const write = actionNode(WRITE_CONTRACT, {
    ...WRITE_CONFIG,
    sponsorGas: value,
  });

  it("is refused once the step it reads runs another action", () => {
    expect(
      validateWorkflowActionConfigs([step("Database Query"), write], {
        savedNodes: [step("HTTP Request"), write],
      }).issues
    ).toMatchObject([{ field: "sponsorGas" }]);
    expect(
      validateWorkflowActionConfigs([step("HTTP Request"), write], {
        savedNodes: [step("HTTP Request"), write],
      }).issues
    ).toEqual([]);
  });

  it("keeps a default-on toggle saved while its condition hid it", () => {
    const hidden = actionNode(WRITE_CONTRACT, {
      ...WRITE_CONFIG,
      network: "999999999",
      sponsorGas: TEMPLATE,
    });
    expect(
      validateWorkflowActionConfigs([WEBHOOK, hidden], {
        savedNodes: [WEBHOOK, hidden],
      }).issues
    ).toEqual([]);
  });
});

describe("references a kept value reads", () => {
  const step = (id: string, actionType: string) => ({
    id,
    type: "action",
    data: { label: "S", type: "action", config: { actionType } },
  });
  const write = (sponsorGas: string) =>
    actionNode(WRITE_CONTRACT, { ...WRITE_CONFIG, sponsorGas });
  const issues = (nodes: unknown[], savedNodes: unknown[]) =>
    validateWorkflowActionConfigs(
      nodes as Parameters<typeof validateWorkflowActionConfigs>[0],
      { savedNodes }
    ).issues.filter((issue) => issue.field === "sponsorGas");

  it("are never kept when they read nothing when saved", () => {
    const value = "{{@gone:G.flag}}";
    expect(issues([write(value)], [write(value)])).toHaveLength(1);
  });

  it("cover every node stored under the same output key", () => {
    const value = "{{@a_b:S.flag}}";
    const saved = [step("a-b", "HTTP Request"), step("a_b", "HTTP Request")];
    const now = [step("a-b", "HTTP Request"), step("a_b", "Database Query")];
    expect(
      issues([...now, write(value)], [...saved, write(value)])
    ).toHaveLength(1);
    expect(issues([...saved, write(value)], [...saved, write(value)])).toEqual(
      []
    );
  });

  it("read the path after the dot trimmed, as the step does", () => {
    const saved = [step("n1", "HTTP Request"), write("{{@n1:S.body.flag}}")];
    expect(
      issues([step("n1", "HTTP Request"), write("{{@n1:S. body.flag}}")], saved)
    ).toEqual([]);
  });

  it("match a node whose id has spaces the way the step stores it", () => {
    const value = "{{@_x:S.flag}}";
    const saved = [step("_x", "HTTP Request"), write(value)];
    const spaced = { ...step(" x", "trigger-ish"), type: "trigger" };
    expect(issues([spaced, write(value)], saved)).toHaveLength(1);
  });
});
