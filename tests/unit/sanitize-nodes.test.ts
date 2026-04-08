import { describe, expect, it } from "vitest";
import { sanitizeWorkflowData } from "@/lib/workflow/sanitize-nodes";

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
