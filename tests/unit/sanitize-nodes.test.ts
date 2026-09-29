import { describe, expect, it } from "vitest";
import { sanitizeWorkflowData } from "@/lib/workflow/editor/sanitize-nodes";
import { resolveConditionExpression } from "@/lib/workflow/nodes/condition/resolver";

/** Run one Condition node through the real sanitizer and return what it would store */
function sanitizeConditionConfig(
  config: Record<string, unknown>
): Record<string, unknown> {
  const { nodes } = sanitizeWorkflowData(
    [
      {
        id: "c1",
        type: "action",
        data: { label: "Condition", type: "action", config },
      },
    ],
    []
  );
  const data = nodes[0].data as Record<string, unknown>;
  return data.config as Record<string, unknown>;
}

function storedGroup(config: Record<string, unknown>): Record<string, unknown> {
  const conditionConfig = config.conditionConfig as Record<string, unknown>;
  return conditionConfig.group as Record<string, unknown>;
}

describe("sanitizeWorkflowData", () => {
  describe("React Flow UI state stripping", () => {
    it("strips transient React Flow properties from nodes", () => {
      const { nodes } = sanitizeWorkflowData(
        [
          {
            id: "n1",
            type: "action",
            dragging: false,
            measured: { width: 150, height: 40 },
            selected: true,
            resizing: false,
            zIndex: 5,
            selectable: true,
            connectable: true,
            deletable: true,
            focusable: true,
            positionAbsolute: { x: 100, y: 200 },
            className: "some-class",
            style: { opacity: 1 },
            hidden: false,
            position: { x: 10, y: 20 },
            data: {
              label: "Test",
              type: "action",
              config: { actionType: "web3/check-balance" },
              status: "idle",
            },
          },
        ],
        []
      );

      expect(nodes[0]).toEqual({
        id: "n1",
        type: "action",
        position: { x: 10, y: 20 },
        data: {
          label: "Test",
          type: "action",
          config: { actionType: "web3/check-balance" },
          status: "idle",
        },
      });
    });

    it("strips junk properties from edges", () => {
      const { edges } = sanitizeWorkflowData(
        [],
        [
          {
            id: "e1",
            source: "a",
            target: "b",
            type: "animated",
            sourceHandle: "true",
            animated: true,
            selected: false,
            className: "edge-class",
            style: { stroke: "red" },
            zIndex: 10,
          },
        ]
      );

      expect(edges[0]).toEqual({
        id: "e1",
        source: "a",
        target: "b",
        type: "animated",
        sourceHandle: "true",
      });
    });
  });

  describe("MCP format normalization", () => {
    it("normalizes colon-separated types to slash (Format 2: Compound pattern)", () => {
      const { nodes } = sanitizeWorkflowData(
        [
          {
            id: "n1",
            type: "web3:read-contract",
            data: { type: "action", network: "1", contractAddress: "0x123" },
          },
        ],
        []
      );

      expect(nodes[0].type).toBe("action");
      const data = nodes[0].data as Record<string, unknown>;
      const config = data.config as Record<string, unknown>;
      expect(config.actionType).toBe("web3/read-contract");
      expect(config.network).toBe("1");
      expect(config.contractAddress).toBe("0x123");
    });

    it("normalizes slash-separated types with root config (Format 3: Ethena pattern)", () => {
      const { nodes } = sanitizeWorkflowData(
        [
          {
            id: "n1",
            type: "ethena/vault-total-assets",
            data: { label: "Read Assets", network: "1" },
          },
        ],
        []
      );

      expect(nodes[0].type).toBe("action");
      const data = nodes[0].data as Record<string, unknown>;
      const config = data.config as Record<string, unknown>;
      expect(config.actionType).toBe("ethena/vault-total-assets");
      expect(config.network).toBe("1");
      expect(data.label).toBe("Read Assets");
    });

    it("detects Schedule as trigger node", () => {
      const { nodes } = sanitizeWorkflowData(
        [
          {
            id: "t1",
            type: "Schedule",
            data: {
              type: "action",
              timezone: "UTC",
              cronExpression: "0 * * * *",
            },
          },
        ],
        []
      );

      expect(nodes[0].type).toBe("trigger");
      const data = nodes[0].data as Record<string, unknown>;
      expect(data.type).toBe("trigger");
      const config = data.config as Record<string, unknown>;
      expect(config.triggerType).toBe("Schedule");
      expect(config.timezone).toBe("UTC");
    });

    it("detects system:schedule as trigger node", () => {
      const { nodes } = sanitizeWorkflowData(
        [
          {
            id: "t1",
            type: "system:schedule",
            data: { schedule: "0 * * * *" },
          },
        ],
        []
      );

      expect(nodes[0].type).toBe("trigger");
    });

    it("passes through canonical format without corruption", () => {
      const canonical = {
        id: "a1",
        type: "action",
        position: { x: 252, y: 0 },
        data: {
          label: "Check Balance",
          type: "action",
          config: { actionType: "web3/check-balance", network: "1" },
          status: "idle",
        },
      };

      const { nodes } = sanitizeWorkflowData([canonical], []);
      expect(nodes[0]).toEqual(canonical);
    });

    it("moves misplaced config fields from data root into data.config", () => {
      const { nodes } = sanitizeWorkflowData(
        [
          {
            id: "n1",
            type: "action",
            data: {
              label: "Test",
              type: "action",
              config: { actionType: "web3/check-balance" },
              network: "1",
              address: "0x123",
            },
          },
        ],
        []
      );

      const data = nodes[0].data as Record<string, unknown>;
      const config = data.config as Record<string, unknown>;
      expect(config.network).toBe("1");
      expect(config.address).toBe("0x123");
      expect(data).not.toHaveProperty("network");
      expect(data).not.toHaveProperty("address");
    });
  });

  describe("Condition config normalization", () => {
    it("generates missing ids for groups and rules", () => {
      const { nodes } = sanitizeWorkflowData(
        [
          {
            id: "c1",
            type: "action",
            data: {
              label: "Condition",
              type: "action",
              config: {
                actionType: "Condition",
                conditionConfig: {
                  group: {
                    rules: [
                      {
                        leftOperand: "{{@a:B.x}}",
                        operator: "===",
                        rightOperand: "1",
                      },
                    ],
                    logic: "AND",
                  },
                },
              },
            },
          },
        ],
        []
      );

      const data = nodes[0].data as Record<string, unknown>;
      const config = data.config as Record<string, unknown>;
      const conditionConfig = config.conditionConfig as Record<string, unknown>;
      const group = conditionConfig.group as Record<string, unknown>;
      expect(group.id).toBeDefined();
      expect(typeof group.id).toBe("string");
      const rules = group.rules as Record<string, unknown>[];
      expect(rules[0].id).toBeDefined();
      expect(typeof rules[0].id).toBe("string");
    });

    it("maps operator aliases to canonical symbols", () => {
      const { nodes } = sanitizeWorkflowData(
        [
          {
            id: "c1",
            type: "action",
            data: {
              label: "Condition",
              type: "action",
              config: {
                actionType: "Condition",
                conditionConfig: {
                  group: {
                    rules: [
                      {
                        leftOperand: "a",
                        operator: "equals",
                        rightOperand: "1",
                      },
                      {
                        leftOperand: "b",
                        operator: "less_than",
                        rightOperand: "2",
                      },
                      {
                        leftOperand: "c",
                        operator: "greater_than",
                        rightOperand: "3",
                      },
                      {
                        leftOperand: "d",
                        operator: "not_equals",
                        rightOperand: "4",
                      },
                    ],
                    logic: "AND",
                  },
                },
              },
            },
          },
        ],
        []
      );

      const data = nodes[0].data as Record<string, unknown>;
      const config = data.config as Record<string, unknown>;
      const conditionConfig = config.conditionConfig as Record<string, unknown>;
      const group = conditionConfig.group as Record<string, unknown>;
      const rules = group.rules as Record<string, unknown>[];
      expect(rules[0].operator).toBe("===");
      expect(rules[1].operator).toBe("<");
      expect(rules[2].operator).toBe(">");
      expect(rules[3].operator).toBe("!==");
    });

    it("maps field/value to leftOperand/rightOperand", () => {
      const { nodes } = sanitizeWorkflowData(
        [
          {
            id: "c1",
            type: "action",
            data: {
              label: "Condition",
              type: "action",
              config: {
                actionType: "Condition",
                conditionConfig: {
                  group: {
                    rules: [
                      {
                        field: "{{@a:B.balance}}",
                        operator: "===",
                        value: "100",
                      },
                    ],
                    logic: "AND",
                  },
                },
              },
            },
          },
        ],
        []
      );

      const data = nodes[0].data as Record<string, unknown>;
      const config = data.config as Record<string, unknown>;
      const conditionConfig = config.conditionConfig as Record<string, unknown>;
      const group = conditionConfig.group as Record<string, unknown>;
      const rules = group.rules as Record<string, unknown>[];
      expect(rules[0].leftOperand).toBe("{{@a:B.balance}}");
      expect(rules[0].rightOperand).toBe("100");
      expect(rules[0]).not.toHaveProperty("field");
      expect(rules[0]).not.toHaveProperty("value");
    });

    it("normalizes array-shaped group to single group object", () => {
      const { nodes } = sanitizeWorkflowData(
        [
          {
            id: "c1",
            type: "action",
            data: {
              label: "Condition",
              type: "action",
              config: {
                actionType: "Condition",
                conditionConfig: {
                  group: [
                    { rules: [{ field: "x", operator: "equals", value: "1" }] },
                  ],
                  logicalOperator: "OR",
                },
              },
            },
          },
        ],
        []
      );

      const data = nodes[0].data as Record<string, unknown>;
      const config = data.config as Record<string, unknown>;
      const conditionConfig = config.conditionConfig as Record<string, unknown>;
      const group = conditionConfig.group as Record<string, unknown>;
      expect(group.logic).toBe("OR");
      expect(Array.isArray(group.rules)).toBe(true);
      expect(group).not.toBeInstanceOf(Array);
    });

    it("handles object-shaped operators with key property", () => {
      const { nodes } = sanitizeWorkflowData(
        [
          {
            id: "c1",
            type: "action",
            data: {
              label: "Condition",
              type: "action",
              config: {
                actionType: "Condition",
                conditionConfig: {
                  group: {
                    rules: [
                      {
                        leftOperand: "a",
                        operator: { key: "equals", label: "Equals" },
                        rightOperand: "1",
                      },
                      {
                        leftOperand: "b",
                        operator: { key: "less_than", label: "Less Than" },
                        rightOperand: "2",
                      },
                    ],
                    logic: "AND",
                  },
                },
              },
            },
          },
        ],
        []
      );

      const data = nodes[0].data as Record<string, unknown>;
      const config = data.config as Record<string, unknown>;
      const conditionConfig = config.conditionConfig as Record<string, unknown>;
      const group = conditionConfig.group as Record<string, unknown>;
      const rules = group.rules as Record<string, unknown>[];
      expect(rules[0].operator).toBe("===");
      expect(rules[1].operator).toBe("<");
    });

    it("preserves already valid operators without mutation", () => {
      const { nodes } = sanitizeWorkflowData(
        [
          {
            id: "c1",
            type: "action",
            data: {
              label: "Condition",
              type: "action",
              config: {
                actionType: "Condition",
                conditionConfig: {
                  group: {
                    id: "existing-id",
                    rules: [
                      {
                        id: "rule-1",
                        leftOperand: "a",
                        operator: "===",
                        rightOperand: "b",
                      },
                      {
                        id: "rule-2",
                        leftOperand: "c",
                        operator: ">=",
                        rightOperand: "d",
                      },
                    ],
                    logic: "AND",
                  },
                },
              },
            },
          },
        ],
        []
      );

      const data = nodes[0].data as Record<string, unknown>;
      const config = data.config as Record<string, unknown>;
      const conditionConfig = config.conditionConfig as Record<string, unknown>;
      const group = conditionConfig.group as Record<string, unknown>;
      expect(group.id).toBe("existing-id");
      const rules = group.rules as Record<string, unknown>[];
      expect(rules[0].id).toBe("rule-1");
      expect(rules[0].operator).toBe("===");
      expect(rules[1].operator).toBe(">=");
    });

    // KEEP-2305: some producers emit `group` at the config root instead of
    // nested under `conditionConfig` (matching the ConditionConfig type's
    // own `{ group }` shape). Previously this was silently dropped because
    // the function bailed out whenever `conditionConfig` didn't already
    // exist, leaving the condition to resolve as `undefined` with no
    // signal pointing at the real cause.
    it("folds a root-level group into conditionConfig instead of dropping it", () => {
      const { nodes } = sanitizeWorkflowData(
        [
          {
            id: "c1",
            type: "action",
            data: {
              label: "Condition",
              type: "action",
              config: {
                actionType: "Condition",
                group: {
                  rules: [
                    {
                      leftOperand: "{{@a:B.x}}",
                      operator: "===",
                      rightOperand: "1",
                    },
                  ],
                  logic: "AND",
                },
              },
            },
          },
        ],
        []
      );

      const data = nodes[0].data as Record<string, unknown>;
      const config = data.config as Record<string, unknown>;

      // The stray root-level copy should not survive normalization.
      expect(config.group).toBeUndefined();

      const conditionConfig = config.conditionConfig as Record<string, unknown>;
      expect(conditionConfig).toBeDefined();
      const group = conditionConfig.group as Record<string, unknown>;
      expect(group.id).toBeDefined();
      expect(group.logic).toBe("AND");
      const rules = group.rules as Record<string, unknown>[];
      expect(rules[0].leftOperand).toBe("{{@a:B.x}}");
      expect(rules[0].operator).toBe("===");
    });

    it("prefers an existing conditionConfig over a stray root-level group", () => {
      const { nodes } = sanitizeWorkflowData(
        [
          {
            id: "c1",
            type: "action",
            data: {
              label: "Condition",
              type: "action",
              config: {
                actionType: "Condition",
                conditionConfig: {
                  group: {
                    id: "real-group",
                    logic: "OR",
                    rules: [
                      {
                        id: "r1",
                        leftOperand: "a",
                        operator: "==",
                        rightOperand: "b",
                      },
                    ],
                  },
                },
                // A stray leftover that should be ignored, not merged in.
                group: { logic: "AND", rules: [] },
              },
            },
          },
        ],
        []
      );

      const data = nodes[0].data as Record<string, unknown>;
      const config = data.config as Record<string, unknown>;
      const conditionConfig = config.conditionConfig as Record<string, unknown>;
      const group = conditionConfig.group as Record<string, unknown>;
      expect(group.id).toBe("real-group");
      expect(group.logic).toBe("OR");
    });

    // The array-shaped root-group producer emits `logicalOperator` as a
    // sibling of `group`, not nested under it. Folding the array without
    // carrying `logicalOperator` along silently defaults to "AND" and can
    // invert the branch's actual logic.
    it("preserves logicalOperator when folding an array-shaped root-level group", () => {
      const { nodes } = sanitizeWorkflowData(
        [
          {
            id: "c1",
            type: "action",
            data: {
              label: "Condition",
              type: "action",
              config: {
                actionType: "Condition",
                group: [
                  { leftOperand: "a", operator: "==", rightOperand: "1" },
                  { leftOperand: "b", operator: "==", rightOperand: "2" },
                ],
                logicalOperator: "OR",
              },
            },
          },
        ],
        []
      );

      const data = nodes[0].data as Record<string, unknown>;
      const config = data.config as Record<string, unknown>;
      expect(config.logicalOperator).toBeUndefined();

      const conditionConfig = config.conditionConfig as Record<string, unknown>;
      const group = conditionConfig.group as Record<string, unknown>;
      expect(group.logic).toBe("OR");
      const rules = group.rules as Record<string, unknown>[];
      expect(rules).toHaveLength(2);
    });

    // A nested `conditionConfig` that exists but has no usable `group`
    // (e.g. `{}` or `{ logicalOperator: "OR" }`) is truthy, so checking
    // only "does conditionConfig exist" treats it as authoritative and
    // discards a real root-level group sitting right next to it - the
    // same data loss as the original bug, one shape over.
    it("falls through to a root-level group when the nested conditionConfig has no usable group", () => {
      const { nodes } = sanitizeWorkflowData(
        [
          {
            id: "c1",
            type: "action",
            data: {
              label: "Condition",
              type: "action",
              config: {
                actionType: "Condition",
                conditionConfig: { logicalOperator: "OR" },
                group: {
                  id: "real-group",
                  logic: "AND",
                  rules: [
                    {
                      id: "r1",
                      leftOperand: "a",
                      operator: "==",
                      rightOperand: "b",
                    },
                  ],
                },
              },
            },
          },
        ],
        []
      );

      const data = nodes[0].data as Record<string, unknown>;
      const config = data.config as Record<string, unknown>;
      const conditionConfig = config.conditionConfig as Record<string, unknown>;
      const group = conditionConfig.group as Record<string, unknown>;
      expect(group).toBeDefined();
      expect(group.id).toBe("real-group");
    });
  });

  // The sanitizer runs on every autosave, including one taken mid-edit, so it moves rule
  // groups between keys but never removes one it has not copied somewhere else first.
  describe("Condition save path keeps the author's rules", () => {
    it("keeps a half-typed rule and still refuses to open the gate", () => {
      const config = sanitizeConditionConfig({
        actionType: "Condition",
        conditionConfig: {
          group: {
            id: "g1",
            logic: "AND",
            rules: [
              {
                id: "r1",
                leftOperand: "{{@a:B.x}}",
                operator: "===",
                rightOperand: "",
              },
            ],
          },
        },
        condition: "true",
      });

      const rules = storedGroup(config).rules as Record<string, unknown>[];
      expect(rules).toHaveLength(1);
      expect(rules[0].leftOperand).toBe("{{@a:B.x}}");
      expect(config.condition).toBe("true");
      expect(resolveConditionExpression(config)).toBeUndefined();
    });

    it("keeps an empty group rather than dropping it", () => {
      const config = sanitizeConditionConfig({
        actionType: "Condition",
        conditionConfig: { group: { id: "g1", logic: "AND", rules: [] } },
        condition: "true",
      });

      expect(config.conditionConfig).toBeDefined();
      expect(storedGroup(config).rules).toEqual([]);
      expect(resolveConditionExpression(config)).toBeUndefined();
    });

    it("keeps a root-level group beside a nested one instead of deleting it", () => {
      const config = sanitizeConditionConfig({
        actionType: "Condition",
        conditionConfig: {
          group: {
            id: "real-group",
            logic: "AND",
            rules: [
              {
                id: "r1",
                leftOperand: "{{@a:B.x}}",
                operator: "===",
                rightOperand: "1",
              },
            ],
          },
        },
        group: {
          id: "root-group",
          logic: "AND",
          rules: [
            {
              id: "r2",
              leftOperand: "{{@a:B.y}}",
              operator: "===",
              rightOperand: "2",
            },
          ],
        },
      });

      expect(storedGroup(config).id).toBe("real-group");
      expect(config.group).toBeDefined();
      expect(resolveConditionExpression(config)).toBe("{{@a:B.x}} === 1");
    });

    // Migration 0158 deleted the stale key here because it ran once, over rows that already
    // existed. A save path cannot tell a stale group from the only copy of someone's rules,
    // so it leaves both keys and lets the expression keep deciding, as it already did.
    it("leaves a root-level group alone when an expression already decides the node", () => {
      const config = sanitizeConditionConfig({
        actionType: "Condition",
        group: {
          id: "root-group",
          logic: "AND",
          rules: [
            {
              id: "r1",
              leftOperand: "{{@a:B.stale}}",
              operator: "===",
              rightOperand: "1",
            },
          ],
        },
        condition: "{{@a:B.authored}} === 9",
      });

      expect(config.group).toBeDefined();
      expect(config.conditionConfig).toBeUndefined();
      expect(resolveConditionExpression(config)).toBe(
        "{{@a:B.authored}} === 9"
      );
    });

    it("folds a root-level group when there is no expression to outrank", () => {
      const config = sanitizeConditionConfig({
        actionType: "Condition",
        group: {
          id: "root-group",
          logic: "AND",
          rules: [
            {
              id: "r1",
              leftOperand: "{{@a:B.x}}",
              operator: "===",
              rightOperand: "1",
            },
          ],
        },
        condition: "   ",
      });

      expect(config.group).toBeUndefined();
      expect(storedGroup(config).id).toBe("root-group");
      expect(resolveConditionExpression(config)).toBe("{{@a:B.x}} === 1");
    });
  });

  // groupToExpression joins on "&&" only for an exact "AND", so every other spelling already
  // evaluates as OR. Matching "or" without regard to case keeps the author's operator;
  // anything unrecognised still lands on the stricter AND.
  describe("Condition logic casing", () => {
    it("reads a lowercase group logic as OR", () => {
      const config = sanitizeConditionConfig({
        actionType: "Condition",
        conditionConfig: {
          group: {
            id: "g1",
            logic: "or",
            rules: [
              {
                id: "r1",
                leftOperand: "{{@a:B.x}}",
                operator: "===",
                rightOperand: "1",
              },
              {
                id: "r2",
                leftOperand: "{{@a:B.y}}",
                operator: "===",
                rightOperand: "2",
              },
            ],
          },
        },
      });

      expect(storedGroup(config).logic).toBe("OR");
      expect(resolveConditionExpression(config)).toBe(
        "{{@a:B.x}} === 1 || {{@a:B.y}} === 2"
      );
    });

    it("reads a lowercase logicalOperator as OR when folding an array-shaped group", () => {
      const config = sanitizeConditionConfig({
        actionType: "Condition",
        group: [
          { leftOperand: "{{@a:B.x}}", operator: "===", rightOperand: "1" },
          { leftOperand: "{{@a:B.y}}", operator: "===", rightOperand: "2" },
        ],
        logicalOperator: "or",
      });

      expect(storedGroup(config).logic).toBe("OR");
      expect(resolveConditionExpression(config)).toBe(
        "{{@a:B.x}} === 1 || {{@a:B.y}} === 2"
      );
    });

    it("leaves an unrecognised logic on the stricter AND", () => {
      const config = sanitizeConditionConfig({
        actionType: "Condition",
        conditionConfig: {
          group: {
            id: "g1",
            rules: [
              {
                id: "r1",
                leftOperand: "{{@a:B.x}}",
                operator: "===",
                rightOperand: "1",
              },
              {
                id: "r2",
                leftOperand: "{{@a:B.y}}",
                operator: "===",
                rightOperand: "2",
              },
            ],
          },
        },
      });

      expect(storedGroup(config).logic).toBe("AND");
      expect(resolveConditionExpression(config)).toBe(
        "{{@a:B.x}} === 1 && {{@a:B.y}} === 2"
      );
    });
  });

  describe("Auto-layout", () => {
    it("applies auto-layout when all nodes are at the same position", () => {
      const { nodes } = sanitizeWorkflowData(
        [
          {
            id: "t1",
            type: "trigger",
            data: {
              label: "Trigger",
              type: "trigger",
              config: { triggerType: "Manual" },
            },
          },
          {
            id: "a1",
            type: "action",
            data: {
              label: "Action",
              type: "action",
              config: { actionType: "web3/check-balance" },
            },
          },
        ],
        [{ id: "e1", source: "t1", target: "a1" }]
      );

      const pos0 = nodes[0].position as { x: number; y: number };
      const pos1 = nodes[1].position as { x: number; y: number };
      expect(pos0.x !== pos1.x || pos0.y !== pos1.y).toBe(true);
    });

    it("does not override existing different positions", () => {
      const { nodes } = sanitizeWorkflowData(
        [
          {
            id: "t1",
            type: "trigger",
            position: { x: 0, y: 0 },
            data: { label: "Trigger", type: "trigger", config: {} },
          },
          {
            id: "a1",
            type: "action",
            position: { x: 500, y: 100 },
            data: { label: "Action", type: "action", config: {} },
          },
        ],
        []
      );

      const pos1 = nodes[1].position as { x: number; y: number };
      expect(pos1.x).toBe(500);
      expect(pos1.y).toBe(100);
    });

    it("skips auto-layout for single node", () => {
      const { nodes } = sanitizeWorkflowData(
        [
          {
            id: "t1",
            type: "trigger",
            data: { label: "Trigger", type: "trigger", config: {} },
          },
        ],
        []
      );

      const pos = nodes[0].position as { x: number; y: number };
      expect(pos.x).toBe(0);
      expect(pos.y).toBe(0);
    });
  });

  describe("Defaults", () => {
    it("defaults position to {0, 0} when not provided", () => {
      const { nodes } = sanitizeWorkflowData(
        [
          {
            id: "n1",
            type: "action",
            data: { label: "Test", type: "action", config: {} },
          },
        ],
        []
      );

      expect(nodes[0].position).toEqual({ x: 0, y: 0 });
    });

    it("defaults status to idle when not provided", () => {
      const { nodes } = sanitizeWorkflowData(
        [
          {
            id: "n1",
            type: "action",
            data: { label: "Test", type: "action", config: {} },
          },
        ],
        []
      );

      const data = nodes[0].data as Record<string, unknown>;
      expect(data.status).toBe("idle");
    });

    it("defaults label to empty string when not provided", () => {
      const { nodes } = sanitizeWorkflowData(
        [{ id: "n1", type: "action", data: { type: "action", config: {} } }],
        []
      );

      const data = nodes[0].data as Record<string, unknown>;
      expect(data.label).toBe("");
    });
  });
});
