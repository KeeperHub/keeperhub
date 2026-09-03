import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatActionConfigValidationResponse,
  hasDraftActionNodes,
  isKnownConfigKeyForAction,
  validateWorkflowActionConfigs,
} from "@/lib/workflow/validation/action-config";

function actionNode(
  actionType: string,
  config: Record<string, unknown>,
  id = "node-1"
) {
  return {
    id,
    type: "action",
    data: {
      label: actionType,
      type: "action",
      config: {
        actionType,
        ...config,
      },
    },
  };
}

describe("validateWorkflowActionConfigs", () => {
  it("accepts the valid workflow import fixture", () => {
    const fixture = JSON.parse(
      readFileSync(
        join(import.meta.dirname, "fixtures/workflow-import-valid.json"),
        "utf8"
      )
    ) as { nodes: Parameters<typeof validateWorkflowActionConfigs>[0] };

    expect(validateWorkflowActionConfigs(fixture.nodes)).toEqual({
      valid: true,
      issues: [],
    });
  });

  it("rejects unknown namespaced action types before persistence", () => {
    const result = validateWorkflowActionConfigs([
      actionNode("webhook/send", { webhookUrl: "https://example.com" }),
    ]);

    expect(result.valid).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: "UNKNOWN_ACTION_TYPE",
        path: "nodes[0].data.config.actionType",
        actionType: "webhook/send",
      }),
    ]);
  });

  it("names the offending node and suggests a case-mismatched system action type", () => {
    const result = validateWorkflowActionConfigs([
      {
        id: "reserve-condition",
        type: "action",
        data: {
          label: "Reserve condition",
          type: "action",
          config: { actionType: "condition" },
        },
      },
    ]);

    expect(result.valid).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: "UNKNOWN_ACTION_TYPE",
        nodeId: "reserve-condition",
        nodeLabel: "Reserve condition",
        suggestion: "Condition",
        message: 'Unknown action type "condition". Did you mean "Condition"?',
      }),
    ]);
  });

  it("attaches node identity to unknown-field issues", () => {
    const result = validateWorkflowActionConfigs([
      {
        id: "balance-check",
        type: "action",
        data: {
          label: "Check ETH Balance",
          type: "action",
          config: {
            actionType: "web3/check-balance",
            bogusField: "x",
            network: "11155111",
            address: "0xabc",
          },
        },
      },
    ]);

    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "UNKNOWN_FIELD",
          field: "bogusField",
          nodeId: "balance-check",
          nodeLabel: "Check ETH Balance",
        }),
      ])
    );
  });

  it("rejects wrong config keys and missing required fields", () => {
    const result = validateWorkflowActionConfigs([
      actionNode("discord/send-message", { Message: "hello" }),
    ]);

    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "UNKNOWN_FIELD",
          path: "nodes[0].data.config.Message",
          field: "Message",
          actionType: "discord/send-message",
        }),
        expect.objectContaining({
          code: "MISSING_REQUIRED_FIELD",
          path: "nodes[0].data.config.discordMessage",
          field: "discordMessage",
          actionType: "discord/send-message",
        }),
      ])
    );
  });

  it("skips known companion metadata but still flags real unknown fields", () => {
    const result = validateWorkflowActionConfigs([
      actionNode("aave-v3/supply", {
        network: "1",
        asset: "{{trigger.walletAddress}}",
        amount: "{{@node-1:Previous.amount}}",
        onBehalfOf: "{{@node-1:Previous.recipient}}",
        // Companion display-zone metadata written by the datetime field renderer.
        _tz_broadcastAt: "America/Bogota",
        typoField: "oops",
      }),
    ]);

    const unknownFields = result.issues
      .filter((issue) => issue.code === "UNKNOWN_FIELD")
      .map((issue) => issue.field);
    expect(unknownFields).toEqual(["typoField"]);
  });

  it("reports an underscore key outside the metadata allowlist (typo guard)", () => {
    const result = validateWorkflowActionConfigs([
      actionNode("aave-v3/supply", {
        network: "1",
        asset: "{{trigger.walletAddress}}",
        amount: "{{@node-1:Previous.amount}}",
        onBehalfOf: "{{@node-1:Previous.recipient}}",
        _tz_broadcastAt: "America/Bogota",
        _bogusMeta: "should not silently pass",
      }),
    ]);

    const unknownFields = result.issues
      .filter((issue) => issue.code === "UNKNOWN_FIELD")
      .map((issue) => issue.field);
    expect(unknownFields).toEqual(["_bogusMeta"]);
  });

  it("allows template values in typed protocol fields", () => {
    const result = validateWorkflowActionConfigs([
      actionNode("aave-v3/supply", {
        network: "1",
        asset: "{{trigger.walletAddress}}",
        amount: "{{@node-1:Previous.amount}}",
        onBehalfOf: "{{@node-1:Previous.recipient}}",
      }),
    ]);

    expect(result).toEqual({ valid: true, issues: [] });
  });

  it("rejects invalid literal values in typed protocol address fields", () => {
    const result = validateWorkflowActionConfigs([
      actionNode("aave-v3/supply", {
        network: "1",
        asset: "not-an-address",
        amount: "1000000000000000000",
        onBehalfOf: "0x0000000000000000000000000000000000000001",
      }),
    ]);

    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "INVALID_FIELD_TYPE",
          path: "nodes[0].data.config.asset",
          field: "asset",
          expected: "address",
        }),
      ])
    );
  });

  it("allows template values in isAddressField template-input fields", () => {
    const result = validateWorkflowActionConfigs([
      actionNode("chainlink/ccip-check-bridge-allowance", {
        network: "1",
        contractAddress: "{{trigger.tokenAddress}}",
        owner: "{{trigger.walletAddress}}",
        spender: "{{@node-1:Previous.router}}",
      }),
    ]);

    expect(result).toEqual({ valid: true, issues: [] });
  });

  it("rejects non-address non-template literals in isAddressField fields", () => {
    const result = validateWorkflowActionConfigs([
      actionNode("chainlink/ccip-check-bridge-allowance", {
        network: "1",
        contractAddress: "not-an-address",
        owner: "{{trigger.walletAddress}}",
        spender: "{{@node-1:Previous.router}}",
      }),
    ]);

    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "INVALID_FIELD_TYPE",
          path: "nodes[0].data.config.contractAddress",
          field: "contractAddress",
          expected: "address",
        }),
      ])
    );
  });

  it("accepts JSON-string tuple array protocol fields from the editor", () => {
    const result = validateWorkflowActionConfigs([
      actionNode("chainlink/ccip-send", {
        network: "8453",
        destinationChainSelector: "16015286601757825753",
        receiver: "0x0000000000000000000000000000000000000001",
        data: "0x",
        tokenAmounts:
          '[{"token":"0x0000000000000000000000000000000000000002","amount":"1"}]',
        feeToken: "0x0000000000000000000000000000000000000000",
        extraArgs: "0x",
      }),
    ]);

    expect(result).toEqual({ valid: true, issues: [] });
  });

  it("accepts registered actions with valid config", () => {
    const result = validateWorkflowActionConfigs([
      actionNode("discord/send-message", { discordMessage: "hello" }),
      actionNode("webhook/send-webhook", {
        webhookUrl: "https://example.com",
        webhookMethod: "POST",
      }),
    ]);

    expect(result).toEqual({ valid: true, issues: [] });
  });

  it.each([
    "Database Query",
    "HTTP Request",
    "Condition",
    "For Each",
    "Collect",
  ])("keeps legacy system action %s compatible", (actionType) => {
    const result = validateWorkflowActionConfigs([
      actionNode(actionType, {
        url: "https://example.com",
        method: "GET",
        arbitraryLegacyField: true,
      }),
    ]);

    expect(result).toEqual({ valid: true, issues: [] });
  });

  describe("KEEP-571 stringified container fields (UI wire format)", () => {
    const READ_CONTRACT_ABI = JSON.stringify([
      {
        inputs: [{ internalType: "bytes32", name: "id", type: "bytes32" }],
        name: "reader",
        outputs: [
          { internalType: "uint256", name: "Art", type: "uint256" },
          { internalType: "uint256", name: "rate", type: "uint256" },
        ],
        stateMutability: "view",
        type: "function",
      },
    ]);

    it("accepts a JSON-stringified functionArgs array (the format the UI emits)", () => {
      const result = validateWorkflowActionConfigs([
        actionNode("web3/read-contract", {
          network: "1",
          contractAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
          abi: READ_CONTRACT_ABI,
          abiFunction: "reader",
          functionArgs: '["{{@prev-loop:Prev Loop.currentItem.idBytes32}}"]',
        }),
      ]);

      expect(result).toEqual({ valid: true, issues: [] });
    });

    it("accepts an empty-array functionArgs string (no-arg function)", () => {
      const result = validateWorkflowActionConfigs([
        actionNode("web3/write-contract", {
          network: "1",
          contractAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
          abi: JSON.stringify([
            {
              inputs: [],
              name: "doWrite",
              outputs: [],
              stateMutability: "nonpayable",
              type: "function",
            },
          ]),
          abiFunction: "doWrite",
          functionArgs: "[]",
        }),
      ]);

      expect(result).toEqual({ valid: true, issues: [] });
    });

    it("accepts an empty-string functionArgs (form initial state)", () => {
      const result = validateWorkflowActionConfigs([
        actionNode("web3/read-contract", {
          network: "1",
          contractAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
          abi: READ_CONTRACT_ABI,
          abiFunction: "reader",
          functionArgs: "",
        }),
      ]);

      expect(result).toEqual({ valid: true, issues: [] });
    });

    it("accepts a native array functionArgs (imported / hand-edited)", () => {
      const result = validateWorkflowActionConfigs([
        actionNode("web3/read-contract", {
          network: "1",
          contractAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
          abi: READ_CONTRACT_ABI,
          abiFunction: "reader",
          functionArgs: [
            "0x0000000000000000000000000000000000000000000000000000000000000001",
          ],
        }),
      ]);

      expect(result).toEqual({ valid: true, issues: [] });
    });

    it("accepts a template-only functionArgs value", () => {
      const result = validateWorkflowActionConfigs([
        actionNode("web3/read-contract", {
          network: "1",
          contractAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
          abi: READ_CONTRACT_ABI,
          abiFunction: "reader",
          functionArgs: "{{@previous.argsList}}",
        }),
      ]);

      expect(result).toEqual({ valid: true, issues: [] });
    });

    it("rejects a non-JSON, non-template literal in functionArgs", () => {
      const result = validateWorkflowActionConfigs([
        actionNode("web3/read-contract", {
          network: "1",
          contractAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
          abi: READ_CONTRACT_ABI,
          abiFunction: "reader",
          functionArgs: "not-json",
        }),
      ]);

      expect(result.valid).toBe(false);
      expect(result.issues).toEqual([
        expect.objectContaining({
          code: "INVALID_FIELD_TYPE",
          path: "nodes[0].data.config.functionArgs",
          field: "functionArgs",
          expected: "object or array",
          received: "not-json",
        }),
      ]);
    });

    it("rejects a JSON-stringified scalar in functionArgs (not array/object)", () => {
      const result = validateWorkflowActionConfigs([
        actionNode("web3/read-contract", {
          network: "1",
          contractAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
          abi: READ_CONTRACT_ABI,
          abiFunction: "reader",
          functionArgs: '"only-a-string"',
        }),
      ]);

      expect(result.valid).toBe(false);
      expect(result.issues).toEqual([
        expect.objectContaining({
          code: "INVALID_FIELD_TYPE",
          field: "functionArgs",
        }),
      ]);
    });

    it("accepts a JSON-stringified argsList on batch-read-contract", () => {
      const result = validateWorkflowActionConfigs([
        actionNode("web3/batch-read-contract", {
          inputMode: "uniform",
          network: "1",
          contractAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
          abi: READ_CONTRACT_ABI,
          abiFunction: "reader",
          argsList: '[["0x01"],["0x02"]]',
        }),
      ]);

      expect(result).toEqual({ valid: true, issues: [] });
    });

    it("accepts a JSON-stringified calls list on batch-read-contract (mixed)", () => {
      const result = validateWorkflowActionConfigs([
        actionNode("web3/batch-read-contract", {
          inputMode: "mixed",
          calls:
            '[{"network":"1","contractAddress":"0x6B175474E89094C44Da98b954EedeAC495271d0F","abi":[],"abiFunction":"foo","args":[]}]',
        }),
      ]);

      expect(result).toEqual({ valid: true, issues: [] });
    });

    it("accepts a JSON-stringified object form on a json-editor / object field", () => {
      const result = validateWorkflowActionConfigs([
        actionNode("web3/read-contract", {
          network: "1",
          contractAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
          abi: READ_CONTRACT_ABI,
          abiFunction: "reader",
          functionArgs: '{"named":"args"}',
        }),
      ]);

      expect(result).toEqual({ valid: true, issues: [] });
    });

    it("accepts a 3+ node workflow with web3 read-contract using the UI's stringified form", () => {
      const result = validateWorkflowActionConfigs([
        {
          id: "trigger",
          type: "trigger",
          data: {
            label: "Trigger",
            type: "trigger",
            config: { actionType: "Manual" },
          },
        },
        actionNode(
          "web3/read-contract",
          {
            network: "1",
            contractAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
            abi: READ_CONTRACT_ABI,
            abiFunction: "reader",
            functionArgs: '["0x0000000000000000000000000000000000000001"]',
          },
          "node-1"
        ),
        actionNode(
          "web3/write-contract",
          {
            network: "1",
            contractAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
            abi: JSON.stringify([
              {
                inputs: [],
                name: "doWrite",
                outputs: [],
                stateMutability: "nonpayable",
                type: "function",
              },
            ]),
            abiFunction: "doWrite",
            functionArgs: "[]",
          },
          "node-2"
        ),
        actionNode(
          "discord/send-message",
          { discordMessage: "done" },
          "node-3"
        ),
      ]);

      expect(result).toEqual({ valid: true, issues: [] });
    });
  });

  describe("batch-write-contract calls[] required fields", () => {
    const DO_WRITE_ABI = JSON.stringify([
      {
        inputs: [],
        name: "doWrite",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
      },
    ]);

    const VALID_CALL = {
      network: "1",
      contractAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
      abi: DO_WRITE_ABI,
      abiFunction: "doWrite",
      args: [],
    };

    it("accepts a batch whose every call is complete", () => {
      const result = validateWorkflowActionConfigs([
        actionNode("web3/batch-write-contract", {
          network: "1",
          calls: JSON.stringify([VALID_CALL, VALID_CALL]),
        }),
      ]);

      expect(result).toEqual({ valid: true, issues: [] });
    });

    it("flags a missing contractAddress on the second call, not just the first", () => {
      const result = validateWorkflowActionConfigs([
        actionNode("web3/batch-write-contract", {
          network: "1",
          calls: JSON.stringify([
            VALID_CALL,
            { ...VALID_CALL, contractAddress: "" },
          ]),
        }),
      ]);

      expect(result.valid).toBe(false);
      expect(result.issues).toEqual([
        expect.objectContaining({
          code: "MISSING_REQUIRED_FIELD",
          path: "nodes[0].data.config.calls[1].contractAddress",
          field: "calls[1].contractAddress",
          actionType: "web3/batch-write-contract",
        }),
      ]);
    });

    it("flags every missing field on a fully blank call", () => {
      const result = validateWorkflowActionConfigs([
        actionNode("web3/batch-write-contract", {
          network: "1",
          calls: JSON.stringify([
            VALID_CALL,
            {
              network: "1",
              contractAddress: "",
              abi: "",
              abiFunction: "",
              args: [],
            },
          ]),
        }),
      ]);

      expect(result.valid).toBe(false);
      const paths = result.issues.map((issue) => issue.path);
      expect(paths).toEqual([
        "nodes[0].data.config.calls[1].contractAddress",
        "nodes[0].data.config.calls[1].abi",
        "nodes[0].data.config.calls[1].abiFunction",
      ]);
    });

    it("rejects an unparseable calls value via the existing type check", () => {
      const result = validateWorkflowActionConfigs([
        actionNode("web3/batch-write-contract", {
          network: "1",
          calls: "not json",
        }),
      ]);

      expect(result.valid).toBe(false);
      expect(result.issues).toEqual([
        expect.objectContaining({
          code: "INVALID_FIELD_TYPE",
          path: "nodes[0].data.config.calls",
          field: "calls",
          actionType: "web3/batch-write-contract",
        }),
      ]);
    });
  });

  describe("KEEP-571 legacy field aliases", () => {
    const WRITE_CONTRACT_ABI = JSON.stringify([
      {
        inputs: [],
        name: "doWrite",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
      },
    ]);

    it("accepts legacy functionName on web3/write-contract when abiFunction is absent", () => {
      const result = validateWorkflowActionConfigs([
        actionNode("web3/write-contract", {
          network: "1",
          contractAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
          abi: WRITE_CONTRACT_ABI,
          functionName: "doWrite",
          functionArgs: "[]",
        }),
      ]);

      expect(result).toEqual({ valid: true, issues: [] });
    });

    it("accepts legacy functionName on web3/read-contract", () => {
      const result = validateWorkflowActionConfigs([
        actionNode("web3/read-contract", {
          network: "1",
          contractAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
          abi: "[]",
          functionName: "balanceOf",
          functionArgs: '["{{trigger.walletAddress}}"]',
        }),
      ]);

      expect(result).toEqual({ valid: true, issues: [] });
    });

    it("prefers canonical abiFunction over legacy functionName when both are present", () => {
      const result = validateWorkflowActionConfigs([
        actionNode("web3/write-contract", {
          network: "1",
          contractAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
          abi: WRITE_CONTRACT_ABI,
          abiFunction: "doWrite",
          functionName: "stale-legacy-value",
          functionArgs: "[]",
        }),
      ]);

      expect(result).toEqual({ valid: true, issues: [] });
    });

    it("still rejects truly unknown fields even when an alias map exists for the action", () => {
      const result = validateWorkflowActionConfigs([
        actionNode("web3/write-contract", {
          network: "1",
          contractAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
          abi: WRITE_CONTRACT_ABI,
          abiFunction: "doWrite",
          functionArgs: "[]",
          totallyMadeUpField: "nope",
        }),
      ]);

      expect(result.valid).toBe(false);
      expect(result.issues).toEqual([
        expect.objectContaining({
          code: "UNKNOWN_FIELD",
          field: "totallyMadeUpField",
        }),
      ]);
    });

    it("still flags missing required abiFunction when neither canonical nor legacy alias is set", () => {
      const result = validateWorkflowActionConfigs([
        actionNode("web3/write-contract", {
          network: "1",
          contractAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
          abi: WRITE_CONTRACT_ABI,
          functionArgs: "[]",
        }),
      ]);

      expect(result.valid).toBe(false);
      expect(result.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "MISSING_REQUIRED_FIELD",
            field: "abiFunction",
          }),
        ])
      );
    });
  });

  describe("KEEP-571 regression on a multi-template, integrationId-bearing node", () => {
    it("accepts a read-contract node shape that combines stringified args, integrationId, and templated address", () => {
      const result = validateWorkflowActionConfigs([
        actionNode("web3/read-contract", {
          abi: '[{"inputs":[{"internalType":"bytes32","name":"id","type":"bytes32"}],"name":"reader","outputs":[{"internalType":"uint256","name":"a","type":"uint256"},{"internalType":"uint256","name":"b","type":"uint256"}],"stateMutability":"view","type":"function"}]',
          network: "1",
          abiFunction: "reader",
          functionArgs: '["{{@prev-loop:Prev Loop.currentItem.idBytes32}}"]',
          integrationId: "mock-integration-id-00000",
          contractAddress: "{{@prev-fetch:Prev Fetch.data.targetAddress}}",
        }),
      ]);

      expect(result).toEqual({ valid: true, issues: [] });
    });
  });

  describe("KEEP-571 UI-only state and cross-action leak fields", () => {
    it("accepts useManualAbi on web3/write-contract (UI toggle, never a config field)", () => {
      const result = validateWorkflowActionConfigs([
        actionNode("web3/write-contract", {
          network: "1",
          contractAddress: "0x0000000000000000000000000000000000000001",
          abi: JSON.stringify([
            {
              inputs: [],
              name: "cast",
              outputs: [],
              stateMutability: "nonpayable",
              type: "function",
            },
          ]),
          abiFunction: "cast",
          functionArgs: "[]",
          useManualAbi: "true",
        }),
      ]);

      expect(result).toEqual({ valid: true, issues: [] });
    });

    it.each([
      "web3/read-contract",
      "web3/write-contract",
      "web3/query-events",
      "web3/query-transactions",
      "web3/batch-read-contract",
    ])("accepts useManualAbi on %s (global UI state)", (actionType) => {
      const result = validateWorkflowActionConfigs([
        actionNode(actionType, {
          network: "1",
          contractAddress: "0x0000000000000000000000000000000000000001",
          abi: "[]",
          abiFunction: "foo",
          functionArgs: "[]",
          useManualAbi: "true",
        }),
      ]);

      // We only care that useManualAbi itself does NOT show up as UNKNOWN_FIELD.
      const useManualAbiIssues = result.issues.filter(
        (i) => i.field === "useManualAbi"
      );
      expect(useManualAbiIssues).toEqual([]);
    });

    it("accepts inputMode and batchSize leftovers on web3/query-transactions (cross-action UI leak)", () => {
      const result = validateWorkflowActionConfigs([
        actionNode("web3/query-transactions", {
          network: "1",
          contractAddress: "0x0000000000000000000000000000000000000001",
          abi: "[]",
          abiFunction: "schedule",
          inputMode: "uniform",
          batchSize: "100",
          blockCount: "225000",
        }),
      ]);

      const leakIssues = result.issues.filter(
        (i) => i.field === "inputMode" || i.field === "batchSize"
      );
      expect(leakIssues).toEqual([]);
    });

    it("accepts inputMode and batchSize leftovers on web3/query-events (same cross-action leak)", () => {
      const result = validateWorkflowActionConfigs([
        actionNode("web3/query-events", {
          network: "1",
          contractAddress: "0x0000000000000000000000000000000000000001",
          abi: "[]",
          eventName: "Transfer",
          inputMode: "uniform",
          batchSize: "100",
        }),
      ]);

      const leakIssues = result.issues.filter(
        (i) => i.field === "inputMode" || i.field === "batchSize"
      );
      expect(leakIssues).toEqual([]);
    });

    it("accepts the full cross-action leak import payload (combined useManualAbi + inputMode + batchSize)", () => {
      const result = validateWorkflowActionConfigs([
        actionNode("web3/query-transactions", {
          network: "1",
          batchSize: "100",
          inputMode: "uniform",
          blockCount: "225000",
          abi: "[]",
          abiFunction: "schedule",
          useManualAbi: "true",
          contractAddress: "0x0000000000000000000000000000000000000001",
        }),
      ]);

      expect(result).toEqual({ valid: true, issues: [] });
    });

    it("still rejects a TRULY unknown field even when useManualAbi is present", () => {
      const result = validateWorkflowActionConfigs([
        actionNode("web3/read-contract", {
          network: "1",
          contractAddress: "0x0000000000000000000000000000000000000001",
          abi: "[]",
          abiFunction: "foo",
          functionArgs: "[]",
          useManualAbi: "true",
          completelyMadeUpField: "yes",
        }),
      ]);

      expect(result.valid).toBe(false);
      expect(result.issues).toEqual([
        expect.objectContaining({
          code: "UNKNOWN_FIELD",
          field: "completelyMadeUpField",
        }),
      ]);
    });

    it("does not extend the inputMode/batchSize ignore to actions that genuinely use them (batch-read-contract still validates)", () => {
      const result = validateWorkflowActionConfigs([
        actionNode("web3/batch-read-contract", {
          inputMode: "not-a-valid-mode",
          network: "1",
          contractAddress: "0x0000000000000000000000000000000000000001",
          abi: "[]",
          abiFunction: "foo",
          argsList: "[]",
        }),
      ]);

      expect(result.valid).toBe(false);
      expect(result.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "INVALID_FIELD_TYPE",
            field: "inputMode",
          }),
        ])
      );
    });
  });

  describe("node-count invariance (prove >2 node failures were per-node, not threshold)", () => {
    const READ_CONTRACT_ABI = JSON.stringify([
      {
        inputs: [{ internalType: "bytes32", name: "id", type: "bytes32" }],
        name: "reader",
        outputs: [{ internalType: "uint256", name: "Art", type: "uint256" }],
        stateMutability: "view",
        type: "function",
      },
    ]);

    function makeAffectedReadNode(id: string): ReturnType<typeof actionNode> {
      return actionNode(
        "web3/read-contract",
        {
          network: "1",
          contractAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
          abi: READ_CONTRACT_ABI,
          abiFunction: "reader",
          functionArgs:
            '["0x0000000000000000000000000000000000000000000000000000000000000001"]',
        },
        id
      );
    }

    function makeFillerNode(id: string): ReturnType<typeof actionNode> {
      return actionNode("discord/send-message", { discordMessage: id }, id);
    }

    it.each([
      1, 2, 3, 5, 10, 20,
    ])("a workflow of size %i with the affected node passes", (size) => {
      const nodes: ReturnType<typeof actionNode>[] = [];
      for (let i = 0; i < size; i++) {
        nodes.push(
          i === 0 ? makeAffectedReadNode(`n-${i}`) : makeFillerNode(`n-${i}`)
        );
      }

      const result = validateWorkflowActionConfigs(nodes);
      expect(result).toEqual({ valid: true, issues: [] });
    });

    it.each([
      0, 1, 3, 5, 9,
    ])("validation outcome is identical regardless of affected-node index (idx=%i in 10-node workflow)", (affectedIndex) => {
      const nodes: ReturnType<typeof actionNode>[] = [];
      for (let i = 0; i < 10; i++) {
        nodes.push(
          i === affectedIndex
            ? makeAffectedReadNode(`n-${i}`)
            : makeFillerNode(`n-${i}`)
        );
      }

      const result = validateWorkflowActionConfigs(nodes);
      expect(result).toEqual({ valid: true, issues: [] });
    });

    it("a workflow with N affected nodes still passes (no aggregate cap)", () => {
      const nodes: ReturnType<typeof actionNode>[] = [];
      for (let i = 0; i < 15; i++) {
        nodes.push(makeAffectedReadNode(`n-${i}`));
      }

      const result = validateWorkflowActionConfigs(nodes);
      expect(result).toEqual({ valid: true, issues: [] });
    });

    it("reports invalid fields at the correct node index in a 6-node workflow", () => {
      const nodes = [
        makeFillerNode("n-0"),
        makeFillerNode("n-1"),
        makeFillerNode("n-2"),
        actionNode(
          "web3/read-contract",
          {
            network: "1",
            contractAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
            abi: READ_CONTRACT_ABI,
            abiFunction: "reader",
            functionArgs: "not-json-not-template",
          },
          "n-3"
        ),
        makeFillerNode("n-4"),
        makeFillerNode("n-5"),
      ];

      const result = validateWorkflowActionConfigs(nodes);
      expect(result.valid).toBe(false);
      expect(result.issues).toEqual([
        expect.objectContaining({
          code: "INVALID_FIELD_TYPE",
          path: "nodes[3].data.config.functionArgs",
        }),
      ]);
    });

    it("collects issues from multiple affected nodes spread across the array", () => {
      const nodes = [
        actionNode(
          "web3/read-contract",
          {
            network: "1",
            contractAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
            abi: READ_CONTRACT_ABI,
            abiFunction: "reader",
            functionArgs: "bogus-a",
          },
          "n-0"
        ),
        makeFillerNode("n-1"),
        makeFillerNode("n-2"),
        actionNode(
          "web3/read-contract",
          {
            network: "1",
            contractAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
            abi: READ_CONTRACT_ABI,
            abiFunction: "reader",
            functionArgs: "bogus-b",
          },
          "n-3"
        ),
        makeFillerNode("n-4"),
      ];

      const result = validateWorkflowActionConfigs(nodes);
      expect(result.valid).toBe(false);
      expect(result.issues).toHaveLength(2);
      expect(result.issues[0]).toMatchObject({
        path: "nodes[0].data.config.functionArgs",
        received: "bogus-a",
      });
      expect(result.issues[1]).toMatchObject({
        path: "nodes[3].data.config.functionArgs",
        received: "bogus-b",
      });
    });
  });

  describe("broader save-time edge cases (not specific to KEEP-571)", () => {
    it("accepts an empty nodes array (new workflow placeholder)", () => {
      const result = validateWorkflowActionConfigs([]);
      expect(result).toEqual({ valid: true, issues: [] });
    });

    it("skips trigger nodes entirely (validator only gates action nodes)", () => {
      const result = validateWorkflowActionConfigs([
        {
          id: "trigger",
          type: "trigger",
          data: {
            type: "trigger",
            config: { actionType: "Manual", anyArbitraryField: 42 },
          },
        },
      ]);
      expect(result).toEqual({ valid: true, issues: [] });
    });

    it("skips nodes whose data.config is missing or non-object", () => {
      const result = validateWorkflowActionConfigs([
        { id: "n-0", type: "action", data: { type: "action" } },
        {
          id: "n-1",
          type: "action",
          data: { type: "action", config: null as never },
        },
      ]);
      expect(result).toEqual({ valid: true, issues: [] });
    });

    it("skips nodes with missing or blank actionType (incomplete authoring state)", () => {
      const result = validateWorkflowActionConfigs([
        {
          id: "n-0",
          type: "action",
          data: { type: "action", config: { actionType: "" } },
        },
        {
          id: "n-1",
          type: "action",
          data: { type: "action", config: {} },
        },
      ]);
      expect(result).toEqual({ valid: true, issues: [] });
    });

    it("does not flag RESERVED_CONFIG_KEYS (integrationId, actionType, addressBookSelection, usePrivateMempool, strict)", () => {
      const result = validateWorkflowActionConfigs([
        actionNode("discord/send-message", {
          discordMessage: "hi",
          integrationId: "intg-1",
          usePrivateMempool: true,
          strict: false,
        }),
      ]);
      expect(result).toEqual({ valid: true, issues: [] });
    });

    it("accepts a number for a string-like field (validator coerces stringLike)", () => {
      const result = validateWorkflowActionConfigs([
        actionNode("discord/send-message", { discordMessage: 12_345 }),
      ]);
      expect(result).toEqual({ valid: true, issues: [] });
    });

    it("rejects an object for a string-like field", () => {
      const result = validateWorkflowActionConfigs([
        actionNode("discord/send-message", {
          discordMessage: { not: "a string" },
        }),
      ]);
      expect(result.valid).toBe(false);
      expect(result.issues).toEqual([
        expect.objectContaining({
          code: "INVALID_FIELD_TYPE",
          field: "discordMessage",
        }),
      ]);
    });

    it("respects showWhen gating: hidden required field is not flagged missing", () => {
      const result = validateWorkflowActionConfigs([
        actionNode("web3/batch-read-contract", {
          inputMode: "mixed",
          calls:
            '[{"network":"1","contractAddress":"0x6B175474E89094C44Da98b954EedeAC495271d0F","abi":[],"abiFunction":"foo","args":[]}]',
        }),
      ]);
      expect(result).toEqual({ valid: true, issues: [] });
    });

    it("flags a missing required field that IS visible under showWhen", () => {
      const result = validateWorkflowActionConfigs([
        actionNode("web3/batch-read-contract", {
          inputMode: "uniform",
        }),
      ]);
      expect(result.valid).toBe(false);
      expect(result.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "MISSING_REQUIRED_FIELD",
            field: "network",
          }),
        ])
      );
    });

    it("validates each node independently: one broken node does not invalidate sibling nodes", () => {
      const result = validateWorkflowActionConfigs([
        actionNode("discord/send-message", { discordMessage: "valid" }, "n-0"),
        actionNode(
          "webhook/send-webhook",
          {
            webhookUrl: "https://example.com",
            webhookMethod: "POST",
          },
          "n-1"
        ),
        actionNode("discord/send-message", { Message: "wrong-case" }, "n-2"),
      ]);
      expect(result.valid).toBe(false);
      const paths = result.issues.map((i) => i.path);
      expect(paths.every((p) => p.startsWith("nodes[2]"))).toBe(true);
    });

    it("returns deterministic issue ordering across the node array", () => {
      const nodes: ReturnType<typeof actionNode>[] = [];
      for (let i = 0; i < 5; i++) {
        nodes.push(
          actionNode("discord/send-message", { Message: `bad-${i}` }, `n-${i}`)
        );
      }
      const result = validateWorkflowActionConfigs(nodes);
      const unknownFieldPaths = result.issues
        .filter((i) => i.code === "UNKNOWN_FIELD")
        .map((i) => i.path);
      expect(unknownFieldPaths).toEqual([
        "nodes[0].data.config.Message",
        "nodes[1].data.config.Message",
        "nodes[2].data.config.Message",
        "nodes[3].data.config.Message",
        "nodes[4].data.config.Message",
      ]);
    });

    it("does not double-report the same field as both UNKNOWN_FIELD and INVALID_FIELD_TYPE", () => {
      const result = validateWorkflowActionConfigs([
        actionNode("discord/send-message", { discordMessage: "ok" }),
      ]);
      expect(result).toEqual({ valid: true, issues: [] });
    });

    it("accepts a node that uses an integer-string for a protocol-uint field (chainId-style)", () => {
      const result = validateWorkflowActionConfigs([
        actionNode("aave-v3/supply", {
          network: "1",
          asset: "0x0000000000000000000000000000000000000001",
          amount: "1000000000000000000",
          onBehalfOf: "0x0000000000000000000000000000000000000002",
        }),
      ]);
      expect(result).toEqual({ valid: true, issues: [] });
    });

    it("rejects an empty string for a required string field (treated as missing)", () => {
      const result = validateWorkflowActionConfigs([
        actionNode("webhook/send-webhook", {
          webhookUrl: "",
          webhookMethod: "POST",
        }),
      ]);
      expect(result.valid).toBe(false);
      expect(result.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "MISSING_REQUIRED_FIELD",
            field: "webhookUrl",
          }),
        ])
      );
    });
  });

  describe("draft state (Hub 'Use in Workflow' flow)", () => {
    it("accepts a protocol action node with only actionType set", () => {
      const result = validateWorkflowActionConfigs([
        {
          id: "n-1",
          type: "action",
          data: { type: "action", config: { actionType: "aave-v3/supply" } },
        },
      ]);
      expect(result).toEqual({ valid: true, issues: [] });
    });

    it("accepts a protocol action node with actionType and _protocolMeta only", () => {
      const protocolMeta = JSON.stringify({
        protocolSlug: "aave-v3",
        contractKey: "pool",
        functionName: "supply",
        actionType: "write",
      });
      const result = validateWorkflowActionConfigs([
        {
          id: "n-1",
          type: "action",
          data: {
            type: "action",
            config: {
              actionType: "aave-v3/supply",
              _protocolMeta: protocolMeta,
            },
          },
        },
      ]);
      expect(result).toEqual({ valid: true, issues: [] });
    });

    it("accepts actionType combined with only reserved keys (e.g. integrationId)", () => {
      const result = validateWorkflowActionConfigs([
        {
          id: "n-1",
          type: "action",
          data: {
            type: "action",
            config: {
              actionType: "discord/send-message",
              integrationId: "integ-abc",
            },
          },
        },
      ]);
      expect(result).toEqual({ valid: true, issues: [] });
    });

    it("resumes required-field validation once any user param is present", () => {
      const result = validateWorkflowActionConfigs([
        actionNode("aave-v3/supply", { network: "1" }),
      ]);
      expect(result.valid).toBe(false);
      expect(result.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "MISSING_REQUIRED_FIELD",
            field: "asset",
          }),
          expect.objectContaining({
            code: "MISSING_REQUIRED_FIELD",
            field: "amount",
          }),
          expect.objectContaining({
            code: "MISSING_REQUIRED_FIELD",
            field: "onBehalfOf",
          }),
        ])
      );
    });

    it("still reports UNKNOWN_FIELD for unrecognised keys even in draft state", () => {
      const result = validateWorkflowActionConfigs([
        {
          id: "n-1",
          type: "action",
          data: {
            type: "action",
            config: { actionType: "aave-v3/supply", unknownKey: "value" },
          },
        },
      ]);
      expect(result.valid).toBe(false);
      expect(result.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "UNKNOWN_FIELD",
            field: "unknownKey",
            actionType: "aave-v3/supply",
          }),
        ])
      );
    });
  });
});

describe("isKnownConfigKeyForAction", () => {
  it("rejects web3 leftover fields after a switch to discord/send-message", () => {
    for (const key of ["abi", "network", "abiFunction", "contractAddress"]) {
      expect(isKnownConfigKeyForAction("discord/send-message", key)).toBe(
        false
      );
    }
  });

  it("keeps fields the target action declares", () => {
    expect(
      isKnownConfigKeyForAction("discord/send-message", "discordMessage")
    ).toBe(true);
  });

  it("keeps reserved structural keys for any action", () => {
    for (const key of ["actionType", "integrationId"]) {
      expect(isKnownConfigKeyForAction("discord/send-message", key)).toBe(true);
    }
  });

  it("keeps legacy aliases that map to a declared field", () => {
    expect(
      isKnownConfigKeyForAction("web3/read-contract", "functionName")
    ).toBe(true);
  });

  it("keeps legacy ignored fields for the target action", () => {
    expect(
      isKnownConfigKeyForAction("web3/query-transactions", "inputMode")
    ).toBe(true);
  });

  it("does not prune when the action type is unknown", () => {
    expect(isKnownConfigKeyForAction("not-a-real/action", "anything")).toBe(
      true
    );
  });
});

describe("hasDraftActionNodes", () => {
  it("returns true when an action node has only actionType", () => {
    expect(
      hasDraftActionNodes([
        {
          id: "n-1",
          type: "action",
          data: { type: "action", config: { actionType: "aave-v3/supply" } },
        },
      ])
    ).toBe(true);
  });

  it("returns true when an action node has actionType and _protocolMeta only", () => {
    expect(
      hasDraftActionNodes([
        {
          id: "n-1",
          type: "action",
          data: {
            type: "action",
            config: { actionType: "aave-v3/supply", _protocolMeta: "{}" },
          },
        },
      ])
    ).toBe(true);
  });

  it("returns false when an action node has at least one user parameter", () => {
    expect(
      hasDraftActionNodes([actionNode("aave-v3/supply", { network: "1" })])
    ).toBe(false);
  });

  it("returns false for an empty node list", () => {
    expect(hasDraftActionNodes([])).toBe(false);
  });

  it("returns false when all action nodes are fully configured", () => {
    expect(
      hasDraftActionNodes([
        actionNode("aave-v3/supply", {
          network: "1",
          asset: "0xabc",
          amount: "100",
          onBehalfOf: "0xdef",
        }),
      ])
    ).toBe(false);
  });

  it("returns true only for the draft node when mixed with configured nodes", () => {
    expect(
      hasDraftActionNodes([
        actionNode(
          "discord/send-message",
          { channelId: "123", message: "hi" },
          "n-1"
        ),
        {
          id: "n-2",
          type: "action",
          data: { type: "action", config: { actionType: "aave-v3/supply" } },
        },
      ])
    ).toBe(true);
  });

  it("ignores non-action nodes", () => {
    expect(
      hasDraftActionNodes([
        { id: "n-1", type: "trigger", data: { type: "trigger", config: {} } },
      ])
    ).toBe(false);
  });
});

describe("formatActionConfigValidationResponse", () => {
  it("returns a structured 422 body shape for route handlers", () => {
    const validation = validateWorkflowActionConfigs([
      actionNode("webhook/send", {}),
    ]);

    expect(formatActionConfigValidationResponse(validation)).toEqual({
      error: "INVALID_ACTION_CONFIG",
      message:
        'Workflow contains invalid action configuration. Invalid node(s): "webhook/send". Fix the listed fields and save again.',
      invalidFields: validation.issues,
    });
  });

  it("names the invalid node in the top-level message", () => {
    const validation = validateWorkflowActionConfigs([
      {
        id: "reserve-condition",
        type: "action",
        data: {
          label: "Reserve condition",
          type: "action",
          config: { actionType: "condition" },
        },
      },
    ]);

    expect(formatActionConfigValidationResponse(validation).message).toContain(
      '"Reserve condition"'
    );
  });

  it("caps node labels in the summary", () => {
    const longLabel = "A".repeat(200);
    const result = formatActionConfigValidationResponse({
      valid: false,
      issues: [
        {
          code: "UNKNOWN_FIELD",
          path: "nodes[0].data.config.bogus",
          actionType: "discord/send-message",
          field: "bogus",
          message: "Unknown field",
          nodeLabel: longLabel,
        },
      ],
    });

    expect(result.message).toContain("...");
    expect(result.message).not.toContain("A".repeat(101));
  });

  it("strips control characters from node labels in the summary", () => {
    const result = formatActionConfigValidationResponse({
      valid: false,
      issues: [
        {
          code: "UNKNOWN_FIELD",
          path: "nodes[0].data.config.bogus",
          actionType: "discord/send-message",
          field: "bogus",
          message: "Unknown field",
          nodeLabel: "My\x00Node",
        },
      ],
    });

    expect(result.message).toContain('"My Node"');
  });

  it("strips bidi isolates from node labels in the summary", () => {
    const result = formatActionConfigValidationResponse({
      valid: false,
      issues: [
        {
          code: "UNKNOWN_FIELD",
          path: "nodes[0].data.config.bogus",
          actionType: "discord/send-message",
          field: "bogus",
          message: "Unknown field",
          nodeLabel: "\u2067Send Payout\u2069",
        },
      ],
    });

    expect(result.message).toContain('"Send Payout"');
  });

  it("escapes format delimiters in node labels to prevent fake entries", () => {
    const result = formatActionConfigValidationResponse({
      valid: false,
      issues: [
        {
          code: "UNKNOWN_FIELD",
          path: "nodes[0].data.config.bogus",
          actionType: "discord/send-message",
          field: "bogus",
          message: "Unknown field",
          nodeLabel: 'A" (webhook/send)',
        },
      ],
    });

    expect(result.message).toContain('"A\' [webhook/send]"');
  });

  it("falls back to nodeId when sanitised label is blank", () => {
    const result = formatActionConfigValidationResponse({
      valid: false,
      issues: [
        {
          code: "UNKNOWN_FIELD",
          path: "nodes[0].data.config.bogus",
          actionType: "discord/send-message",
          field: "bogus",
          message: "Unknown field",
          nodeId: "my-node",
          nodeLabel: "\u200b",
        },
      ],
    });

    expect(result.message).toContain('"my-node"');
  });

  it("shows at most three distinct nodes in the summary", () => {
    const issues = Array.from({ length: 10 }, (_, i) => ({
      code: "UNKNOWN_FIELD" as const,
      path: `nodes[${i}].data.config.bogus`,
      actionType: "discord/send-message",
      field: "bogus",
      message: "Unknown field",
      nodeLabel: `Node ${i}`,
    }));

    const result = formatActionConfigValidationResponse({
      valid: false,
      issues,
    });

    expect(result.message).toContain("and 7 more");
  });

  it("deduplicates repeated node labels in the summary", () => {
    const result = formatActionConfigValidationResponse({
      valid: false,
      issues: [
        {
          code: "UNKNOWN_FIELD",
          path: "nodes[0].data.config.a",
          actionType: "discord/send-message",
          field: "a",
          message: "Unknown field a",
          nodeLabel: "Send Notification",
        },
        {
          code: "UNKNOWN_FIELD",
          path: "nodes[0].data.config.b",
          actionType: "discord/send-message",
          field: "b",
          message: "Unknown field b",
          nodeLabel: "Send Notification",
        },
      ],
    });

    expect(result.message).toContain('"Send Notification" (2 issues)');
  });
});
