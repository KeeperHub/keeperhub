/**
 * Factory tests for the deterministic workflow factory (52-03).
 *
 * Requirements covered: PREFILL-01..07 + HF condition coercion (SC#1)
 * Wave 0 scaffold; Wave 2 (52-03) implementation turns all tests GREEN.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  type ValidatorWorkflow,
  validateWorkflow,
} from "@/lib/mcp/validate-workflow";
import { buildWorkflow } from "@/lib/scan/factory";
import type { PrefillWorkflow } from "@/lib/scan/factory/types";
import {
  validateNoApproveTokenNode,
  validateNoMaxUint256Approval,
  validateTemplateRefs,
} from "@/lib/scan/factory/validate";
import { buildSuggestions } from "@/lib/scan/suggestions/engine";
import type { SuggestionDescriptor } from "@/lib/scan/suggestions/types";
import type { ScanResponse } from "@/lib/scan/types";
import type { WorkflowNode } from "@/lib/workflow/store";

// ---------------------------------------------------------------------------
// Top-level regex constants (useTopLevelRegex rule)
// ---------------------------------------------------------------------------

const RE_WRITE_ACTION = /write-contract|protocol-write/;
const RE_HF_1E18 = /^\d{19}$/;
// Matches simple {{key}} Phase-53 substitution placeholders (no leading @).
const RE_SIMPLE_PLACEHOLDER = /\{\{([^@}][^}]*)\}\}/g;

// ---------------------------------------------------------------------------
// ConditionConfig inline type (avoids `as any` for dynamic conditionConfig)
// ---------------------------------------------------------------------------

type ConditionGroup = {
  rules?: Array<{ rightOperand?: unknown; operator?: string }>;
};
type ConditionConfig = { group?: ConditionGroup } | undefined;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ARBITRUM_USDC = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";

const HEALTH_DESCRIPTOR: SuggestionDescriptor = {
  id: "hf-monitor-aave-v3-42161",
  name: "Aave V3 Health Factor Alert",
  description:
    "Monitor HF (currently 1.80) on Arbitrum. Alert when HF drops below 1.5.",
  category: "health",
  chainId: 42_161,
  readOrWrite: "read",
  protocol: "aave-v3",
  usdValue: 5000,
  riskNote:
    "Read-only monitoring. This workflow does not make any transactions.",
  confirmInputs: {
    walletAddress: "Your wallet address to monitor",
    // Matches engine.ts buildHealthSuggestion: hfThresholdRaw(clampHfThreshold(1.80)) = 1.5 → 1e18 string
    threshold: "1500000000000000000",
  },
};

const YIELD_DESCRIPTOR: SuggestionDescriptor = {
  id: "yield-monitor-usdc-42161",
  name: "Arbitrum USDC Idle Yield Monitor",
  description: "Monitor 500 USDC on Arbitrum for yield opportunities.",
  category: "yield",
  chainId: 42_161,
  readOrWrite: "read",
  protocol: undefined,
  usdValue: 500,
  riskNote:
    "Read-only monitoring. This workflow does not make any transactions.",
  confirmInputs: {
    walletAddress: "Your wallet address to monitor",
  },
};

// A node that would trigger the MaxUint256 validator
const MAX_UINT256_STR =
  "115792089237316195423570985008687907853269984665640564039457584007913129639935";

const APPROVE_NODE_MAX: WorkflowNode = {
  id: "bad-approve",
  type: "action",
  position: { x: 100, y: 200 },
  data: {
    type: "action",
    label: "Approve Token (Unlimited)",
    config: {
      actionType: "web3/approve-token",
      network: "42161",
      amount: "max",
      tokenAddress: ARBITRUM_USDC,
    },
    status: "idle",
  },
};

const APPROVE_NODE_EXACT: WorkflowNode = {
  id: "good-approve",
  type: "action",
  position: { x: 100, y: 200 },
  data: {
    type: "action",
    label: "Approve Token (Exact)",
    config: {
      actionType: "web3/approve-token",
      network: "42161",
      amount: "1000000",
      tokenAddress: ARBITRUM_USDC,
    },
    status: "idle",
  },
};

// ---------------------------------------------------------------------------
// PREFILL-01: Factory output matches WorkflowNode/WorkflowEdge canvas shape
// ---------------------------------------------------------------------------

describe("PREFILL-01: factory returns PrefillWorkflow with canvas-compatible shape", () => {
  it("buildWorkflow is a function", () => {
    expect(typeof buildWorkflow).toBe("function");
  });

  it("health: buildWorkflow(healthDescriptor) returns an object with nodes and edges arrays", () => {
    const result: PrefillWorkflow = buildWorkflow(HEALTH_DESCRIPTOR);
    expect(Array.isArray(result.nodes)).toBe(true);
    expect(Array.isArray(result.edges)).toBe(true);
  });

  it("health: workflowType is 'read' on all factory output", () => {
    const result: PrefillWorkflow = buildWorkflow(HEALTH_DESCRIPTOR);
    expect(result.workflowType).toBe("read");
  });

  it("health: every node has required canvas fields (id, type, position, data)", () => {
    const result: PrefillWorkflow = buildWorkflow(HEALTH_DESCRIPTOR);
    for (const node of result.nodes) {
      expect(typeof node.id).toBe("string");
      expect(["trigger", "action"]).toContain(node.type);
      expect(typeof node.position.x).toBe("number");
      expect(typeof node.position.y).toBe("number");
      expect(typeof node.data.label).toBe("string");
      expect(["trigger", "action", "add"]).toContain(node.data.type);
    }
  });

  it("health: every edge has id, source, target, and type 'default'", () => {
    const result: PrefillWorkflow = buildWorkflow(HEALTH_DESCRIPTOR);
    for (const edge of result.edges) {
      expect(typeof edge.id).toBe("string");
      expect(typeof edge.source).toBe("string");
      expect(typeof edge.target).toBe("string");
      expect(edge.type).toBe("default");
    }
  });

  it("health: actionType lives at data.config.actionType, not data.actionType (KEEP-571 wire-shape)", () => {
    const result: PrefillWorkflow = buildWorkflow(HEALTH_DESCRIPTOR);
    const actionNodes = result.nodes.filter((n) => n.data.type === "action");
    for (const node of actionNodes) {
      // actionType must be inside data.config, not at the legacy data level
      expect((node.data as Record<string, unknown>).actionType).toBeUndefined();
      expect(node.data.config?.actionType).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// PREFILL-03: Deterministic IDs; every template ref resolves
// ---------------------------------------------------------------------------

describe("PREFILL-03: template ref validation", () => {
  it("template ref: validateTemplateRefs is a function", () => {
    expect(typeof validateTemplateRefs).toBe("function");
  });

  it("template ref: factory output passes validateTemplateRefs (all refs resolve)", () => {
    const result: PrefillWorkflow = buildWorkflow(HEALTH_DESCRIPTOR);
    const { valid, errors } = validateTemplateRefs(result.nodes, result.edges);
    expect(errors).toEqual([]);
    expect(valid).toBe(true);
  });

  it("template ref: node IDs are deterministic (same descriptor → same IDs)", () => {
    const a: PrefillWorkflow = buildWorkflow(HEALTH_DESCRIPTOR);
    const b: PrefillWorkflow = buildWorkflow(HEALTH_DESCRIPTOR);
    const aIds = a.nodes.map((n) => n.id).sort();
    const bIds = b.nodes.map((n) => n.id).sort();
    expect(aIds).toEqual(bIds);
  });
});

// ---------------------------------------------------------------------------
// PREFILL-04: chainId injected into config.network as a string
// ---------------------------------------------------------------------------

describe("PREFILL-04: chainId wired into config.network", () => {
  it("network: all web3 nodes in health workflow have config.network === '42161'", () => {
    const result: PrefillWorkflow = buildWorkflow(HEALTH_DESCRIPTOR);
    const web3Nodes = result.nodes.filter(
      (n) => n.data.config?.network !== undefined
    );
    expect(web3Nodes.length).toBeGreaterThan(0);
    for (const node of web3Nodes) {
      expect(node.data.config?.network).toBe("42161");
    }
  });

  it("network: config.network is always a string, not a number", () => {
    const result: PrefillWorkflow = buildWorkflow(YIELD_DESCRIPTOR);
    const web3Nodes = result.nodes.filter(
      (n) => n.data.config?.network !== undefined
    );
    for (const node of web3Nodes) {
      expect(typeof node.data.config?.network).toBe("string");
    }
  });
});

// ---------------------------------------------------------------------------
// PREFILL-05: Schedule interval floor (>= 60s) and per-category defaults
// ---------------------------------------------------------------------------

describe("PREFILL-05: schedule floor and cron defaults", () => {
  it("interval: trigger node uses scheduleCron key (not 'cron')", () => {
    const result: PrefillWorkflow = buildWorkflow(HEALTH_DESCRIPTOR);
    const trigger = result.nodes.find((n) => n.data.type === "trigger");
    expect(trigger?.data.config?.scheduleCron).toBeDefined();
    expect(trigger?.data.config?.cron).toBeUndefined();
  });

  it("interval: trigger node uses scheduleTimezone key (not 'timezone')", () => {
    const result: PrefillWorkflow = buildWorkflow(HEALTH_DESCRIPTOR);
    const trigger = result.nodes.find((n) => n.data.type === "trigger");
    expect(trigger?.data.config?.scheduleTimezone).toBeDefined();
    expect(trigger?.data.config?.timezone).toBeUndefined();
  });

  it("interval: health workflow cron is every 5 minutes (*/5 * * * *)", () => {
    const result: PrefillWorkflow = buildWorkflow(HEALTH_DESCRIPTOR);
    const trigger = result.nodes.find((n) => n.data.type === "trigger");
    expect(trigger?.data.config?.scheduleCron).toBe("*/5 * * * *");
  });
});

// ---------------------------------------------------------------------------
// PREFILL-06: workflowType "read" passes read-only guard
// ---------------------------------------------------------------------------

describe("PREFILL-06: read-only guard", () => {
  it("read-only: health workflow has workflowType 'read'", () => {
    const result: PrefillWorkflow = buildWorkflow(HEALTH_DESCRIPTOR);
    expect(result.workflowType).toBe("read");
  });

  it("read-only: no node in health workflow has a write-type actionType", () => {
    const result: PrefillWorkflow = buildWorkflow(HEALTH_DESCRIPTOR);
    for (const node of result.nodes) {
      const actionType = String(node.data.config?.actionType ?? "");
      expect(actionType).not.toMatch(RE_WRITE_ACTION);
    }
  });
});

// ---------------------------------------------------------------------------
// PREFILL-07: MaxUint256 approval validator
// ---------------------------------------------------------------------------

describe("PREFILL-07: MaxUint256 approval blocked", () => {
  it("MaxUint256: validateNoMaxUint256Approval is a function", () => {
    expect(typeof validateNoMaxUint256Approval).toBe("function");
  });

  it("MaxUint256: node with amount 'max' is rejected", () => {
    const { valid, errors } = validateNoMaxUint256Approval([APPROVE_NODE_MAX]);
    expect(valid).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("MaxUint256: node with numeric MaxUint256 string is rejected", () => {
    const numericMaxNode: WorkflowNode = {
      ...APPROVE_NODE_MAX,
      id: "numeric-max",
      data: {
        ...APPROVE_NODE_MAX.data,
        config: {
          ...APPROVE_NODE_MAX.data.config,
          amount: MAX_UINT256_STR,
        },
      },
    };
    const { valid } = validateNoMaxUint256Approval([numericMaxNode]);
    expect(valid).toBe(false);
  });

  it("MaxUint256: node with exact amount is accepted", () => {
    const { valid, errors } = validateNoMaxUint256Approval([
      APPROVE_NODE_EXACT,
    ]);
    expect(valid).toBe(true);
    expect(errors).toEqual([]);
  });

  it("MaxUint256: factory health workflow passes the MaxUint256 check", () => {
    const result: PrefillWorkflow = buildWorkflow(HEALTH_DESCRIPTOR);
    const { valid } = validateNoMaxUint256Approval(result.nodes);
    expect(valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SC#1: HF condition evaluates correctly with bigint-string comparison
// ---------------------------------------------------------------------------

describe("condition evaluates: HF condition coercion (SC#1)", () => {
  it("condition evaluates: HF monitor condition node carries rightOperand as 1e18-scaled string", () => {
    const result: PrefillWorkflow = buildWorkflow(HEALTH_DESCRIPTOR);
    const condNode = result.nodes.find(
      (n) => String(n.data.config?.actionType) === "Condition"
    );
    expect(condNode).toBeDefined();
    const condConfig = condNode?.data.config
      ?.conditionConfig as ConditionConfig;
    const rules = condConfig?.group?.rules ?? [];
    expect(rules.length).toBeGreaterThan(0);
    // rightOperand should be a 1e18-scaled integer string, e.g. "1500000000000000000"
    const rightOperand = String(rules[0].rightOperand);
    expect(rightOperand).toMatch(RE_HF_1E18);
  });

  it("condition evaluates: condition node uses operator '<' not 'less_than'", () => {
    const result: PrefillWorkflow = buildWorkflow(HEALTH_DESCRIPTOR);
    const condNode = result.nodes.find(
      (n) => String(n.data.config?.actionType) === "Condition"
    );
    const condConfig2 = condNode?.data.config
      ?.conditionConfig as ConditionConfig;
    const rules = condConfig2?.group?.rules ?? [];
    expect(rules[0].operator).toBe("<");
  });
});

// ---------------------------------------------------------------------------
// Task 3 (52-03): stablecoin yield shape + read-only guard conformance
// ---------------------------------------------------------------------------

describe("PREFILL-06 Task 3: yield workflow passes validateWorkflow read-only guard", () => {
  it("read-only: validateWorkflow(workflowType:'read') returns zero errors and zero warnings", () => {
    const result: PrefillWorkflow = buildWorkflow(YIELD_DESCRIPTOR);
    const validatorInput: ValidatorWorkflow = {
      id: "factory-test-yield",
      nodes: result.nodes,
      edges: result.edges,
      inputSchema: null,
      outputMapping: null,
      isListed: false,
      workflowType: "read",
    };
    const validation = validateWorkflow(validatorInput);
    expect(validation.errors).toEqual([]);
    expect(validation.warnings).toEqual([]);
  });

  it("read-only: no yield node has a write-type actionType", () => {
    const result: PrefillWorkflow = buildWorkflow(YIELD_DESCRIPTOR);
    for (const node of result.nodes) {
      const actionType = String(node.data.config?.actionType ?? "");
      expect(actionType).not.toMatch(RE_WRITE_ACTION);
    }
  });
});

describe("PREFILL-01 Task 3: yield shape conforms to canvas wire-shape", () => {
  it("shape: every node satisfies node.type === node.data.type", () => {
    const result: PrefillWorkflow = buildWorkflow(YIELD_DESCRIPTOR);
    for (const node of result.nodes) {
      expect(node.type).toBe(node.data.type);
    }
  });

  it("shape: all edges have type 'default'", () => {
    const result: PrefillWorkflow = buildWorkflow(YIELD_DESCRIPTOR);
    for (const edge of result.edges) {
      expect(edge.type).toBe("default");
    }
  });

  it("shape: yield workflow has 4 nodes and 3 edges", () => {
    const result: PrefillWorkflow = buildWorkflow(YIELD_DESCRIPTOR);
    expect(result.nodes).toHaveLength(4);
    expect(result.edges).toHaveLength(3);
  });

  it("shape: condition→alert edge on yield shape carries sourceHandle 'true'", () => {
    const result: PrefillWorkflow = buildWorkflow(YIELD_DESCRIPTOR);
    const condNode = result.nodes.find(
      (n) => String(n.data.config?.actionType) === "Condition"
    );
    expect(condNode).toBeDefined();
    const condEdge = result.edges.find((e) => e.source === condNode?.id);
    expect(condEdge?.sourceHandle).toBe("true");
  });
});

describe("PREFILL-03 Task 3: yield shape template refs all resolve", () => {
  it("template ref: validateTemplateRefs on yield output returns valid:true", () => {
    const result: PrefillWorkflow = buildWorkflow(YIELD_DESCRIPTOR);
    const { valid, errors } = validateTemplateRefs(result.nodes, result.edges);
    expect(errors).toEqual([]);
    expect(valid).toBe(true);
  });

  it("template ref: yield node IDs are deterministic (same descriptor → same IDs)", () => {
    const a: PrefillWorkflow = buildWorkflow(YIELD_DESCRIPTOR);
    const b: PrefillWorkflow = buildWorkflow(YIELD_DESCRIPTOR);
    const aIds = a.nodes.map((n) => n.id).sort();
    const bIds = b.nodes.map((n) => n.id).sort();
    expect(aIds).toEqual(bIds);
  });
});

// ---------------------------------------------------------------------------
// Task 1 (52-04): price-alert and reward-reminder shapes
// ---------------------------------------------------------------------------

const ALERT_DESCRIPTOR: SuggestionDescriptor = {
  id: "alert-token-42161",
  name: "Token Balance Alert",
  description: "Alert when token balance drops below threshold on Arbitrum.",
  category: "alert",
  chainId: 42_161,
  readOrWrite: "read",
  protocol: undefined,
  usdValue: 200,
  riskNote:
    "Read-only monitoring. This workflow does not make any transactions.",
  confirmInputs: {
    walletAddress: "Your wallet address to monitor",
    tokenAddress: "Token contract address",
    alertThreshold: "Alert threshold amount",
  },
};

const CLAIM_DESCRIPTOR: SuggestionDescriptor = {
  id: "claim-lido-1",
  name: "Lido Staking Reward Reminder",
  description: "Remind you to claim staking rewards from Lido on Ethereum.",
  category: "claim",
  chainId: 1,
  readOrWrite: "read",
  protocol: "lido",
  usdValue: 300,
  riskNote:
    "Read-only monitoring. This workflow does not make any transactions.",
  confirmInputs: {
    walletAddress: "Your wallet address to monitor",
    stakingTokenAddress: "Staking token contract address (e.g. wstETH)",
  },
};

describe("PREFILL-02 alert: price-alert shape", () => {
  it("alert: buildWorkflow(alertDescriptor) returns PrefillWorkflow with workflowType 'read'", () => {
    const result: PrefillWorkflow = buildWorkflow(ALERT_DESCRIPTOR);
    expect(result.workflowType).toBe("read");
    expect(result.nodes.length).toBeGreaterThan(0);
  });

  it("alert: schedule cron is '*/15 * * * *' (every 15 minutes)", () => {
    const result: PrefillWorkflow = buildWorkflow(ALERT_DESCRIPTOR);
    const trigger = result.nodes.find((n) => n.data.type === "trigger");
    expect(trigger?.data.config?.scheduleCron).toBe("*/15 * * * *");
  });

  it("alert: config.network === '42161' on all web3 nodes", () => {
    const result: PrefillWorkflow = buildWorkflow(ALERT_DESCRIPTOR);
    const web3Nodes = result.nodes.filter(
      (n) => n.data.config?.network !== undefined
    );
    expect(web3Nodes.length).toBeGreaterThan(0);
    for (const node of web3Nodes) {
      expect(node.data.config?.network).toBe("42161");
    }
  });

  it("alert: template refs all resolve", () => {
    const result: PrefillWorkflow = buildWorkflow(ALERT_DESCRIPTOR);
    const { valid, errors } = validateTemplateRefs(result.nodes, result.edges);
    expect(errors).toEqual([]);
    expect(valid).toBe(true);
  });

  it("alert: condition→alert edge carries sourceHandle 'true'", () => {
    const result: PrefillWorkflow = buildWorkflow(ALERT_DESCRIPTOR);
    const condNode = result.nodes.find(
      (n) => String(n.data.config?.actionType) === "Condition"
    );
    expect(condNode).toBeDefined();
    const condEdge = result.edges.find((e) => e.source === condNode?.id);
    expect(condEdge?.sourceHandle).toBe("true");
  });

  it("alert: no node has a write-type actionType (read-only)", () => {
    const result: PrefillWorkflow = buildWorkflow(ALERT_DESCRIPTOR);
    for (const node of result.nodes) {
      const actionType = String(node.data.config?.actionType ?? "");
      expect(actionType).not.toMatch(RE_WRITE_ACTION);
    }
  });

  it("alert: every node satisfies node.type === node.data.type", () => {
    const result: PrefillWorkflow = buildWorkflow(ALERT_DESCRIPTOR);
    for (const node of result.nodes) {
      expect(node.type).toBe(node.data.type);
    }
  });
});

describe("PREFILL-02 claim: reward-reminder shape", () => {
  it("claim: buildWorkflow(claimDescriptor) returns PrefillWorkflow with workflowType 'read'", () => {
    const result: PrefillWorkflow = buildWorkflow(CLAIM_DESCRIPTOR);
    expect(result.workflowType).toBe("read");
    expect(result.nodes.length).toBeGreaterThan(0);
  });

  it("claim: schedule cron is '0 */6 * * *' (every 6 hours)", () => {
    const result: PrefillWorkflow = buildWorkflow(CLAIM_DESCRIPTOR);
    const trigger = result.nodes.find((n) => n.data.type === "trigger");
    expect(trigger?.data.config?.scheduleCron).toBe("0 */6 * * *");
  });

  it("claim: config.network === '1' (Ethereum mainnet)", () => {
    const result: PrefillWorkflow = buildWorkflow(CLAIM_DESCRIPTOR);
    const web3Nodes = result.nodes.filter(
      (n) => n.data.config?.network !== undefined
    );
    expect(web3Nodes.length).toBeGreaterThan(0);
    for (const node of web3Nodes) {
      expect(node.data.config?.network).toBe("1");
    }
  });

  it("claim: template refs all resolve", () => {
    const result: PrefillWorkflow = buildWorkflow(CLAIM_DESCRIPTOR);
    const { valid, errors } = validateTemplateRefs(result.nodes, result.edges);
    expect(errors).toEqual([]);
    expect(valid).toBe(true);
  });

  it("claim: condition→reminder edge carries sourceHandle 'true'", () => {
    const result: PrefillWorkflow = buildWorkflow(CLAIM_DESCRIPTOR);
    const condNode = result.nodes.find(
      (n) => String(n.data.config?.actionType) === "Condition"
    );
    expect(condNode).toBeDefined();
    const condEdge = result.edges.find((e) => e.source === condNode?.id);
    expect(condEdge?.sourceHandle).toBe("true");
  });

  it("claim: no node has a write-type actionType (read-only)", () => {
    const result: PrefillWorkflow = buildWorkflow(CLAIM_DESCRIPTOR);
    for (const node of result.nodes) {
      const actionType = String(node.data.config?.actionType ?? "");
      expect(actionType).not.toMatch(RE_WRITE_ACTION);
    }
  });

  it("claim: every node satisfies node.type === node.data.type", () => {
    const result: PrefillWorkflow = buildWorkflow(CLAIM_DESCRIPTOR);
    for (const node of result.nodes) {
      expect(node.type).toBe(node.data.type);
    }
  });
});

// ---------------------------------------------------------------------------
// Task 2 (52-04): generic-monitor fallback + all-categories dispatcher coverage
// ---------------------------------------------------------------------------

// Descriptor with a runtime-only unknown category to exercise the dispatcher
// default branch. The double cast bypasses TypeScript so we can test
// runtime behavior (unreachable via the type system after all 4 cases covered).
const UNKNOWN_CATEGORY_DESCRIPTOR = {
  id: "generic-fallback-test-1",
  name: "Generic Fallback Monitor",
  description: "Generic daily balance check.",
  category: "unknown-category",
  chainId: 1,
  readOrWrite: "read",
  protocol: undefined,
  usdValue: 150,
  riskNote: "Read-only monitoring.",
  confirmInputs: { walletAddress: "Your wallet address" },
} as unknown as SuggestionDescriptor;

describe("PREFILL-02 generic: generic-monitor fallback (dispatcher default branch)", () => {
  it("generic: buildWorkflow with unrecognized category does not throw", () => {
    expect(() => buildWorkflow(UNKNOWN_CATEGORY_DESCRIPTOR)).not.toThrow();
  });

  it("generic: fallback returns PrefillWorkflow with workflowType 'read'", () => {
    const result: PrefillWorkflow = buildWorkflow(UNKNOWN_CATEGORY_DESCRIPTOR);
    expect(result.workflowType).toBe("read");
    expect(result.nodes.length).toBeGreaterThan(0);
  });

  it("generic: schedule cron is '0 9 * * *' (daily at 9am UTC)", () => {
    const result: PrefillWorkflow = buildWorkflow(UNKNOWN_CATEGORY_DESCRIPTOR);
    const trigger = result.nodes.find((n) => n.data.type === "trigger");
    expect(trigger?.data.config?.scheduleCron).toBe("0 9 * * *");
  });

  it("generic: config.network === '1' (matches descriptor.chainId)", () => {
    const result: PrefillWorkflow = buildWorkflow(UNKNOWN_CATEGORY_DESCRIPTOR);
    const web3Nodes = result.nodes.filter(
      (n) => n.data.config?.network !== undefined
    );
    expect(web3Nodes.length).toBeGreaterThan(0);
    for (const node of web3Nodes) {
      expect(node.data.config?.network).toBe("1");
    }
  });

  it("generic: template refs all resolve", () => {
    const result: PrefillWorkflow = buildWorkflow(UNKNOWN_CATEGORY_DESCRIPTOR);
    const { valid, errors } = validateTemplateRefs(result.nodes, result.edges);
    expect(errors).toEqual([]);
    expect(valid).toBe(true);
  });

  it("generic: condition->alert edge carries sourceHandle 'true'", () => {
    const result: PrefillWorkflow = buildWorkflow(UNKNOWN_CATEGORY_DESCRIPTOR);
    const condNode = result.nodes.find(
      (n) => String(n.data.config?.actionType) === "Condition"
    );
    expect(condNode).toBeDefined();
    const condEdge = result.edges.find((e) => e.source === condNode?.id);
    expect(condEdge?.sourceHandle).toBe("true");
  });

  it("generic: every node satisfies node.type === node.data.type", () => {
    const result: PrefillWorkflow = buildWorkflow(UNKNOWN_CATEGORY_DESCRIPTOR);
    for (const node of result.nodes) {
      expect(node.type).toBe(node.data.type);
    }
  });

  it("generic: no node has a write-type actionType (read-only)", () => {
    const result: PrefillWorkflow = buildWorkflow(UNKNOWN_CATEGORY_DESCRIPTOR);
    for (const node of result.nodes) {
      const actionType = String(node.data.config?.actionType ?? "");
      expect(actionType).not.toMatch(RE_WRITE_ACTION);
    }
  });
});

describe("PREFILL-02: all four named categories dispatched without throwing", () => {
  it("dispatcher: buildWorkflow resolves each category to non-empty nodes", () => {
    for (const desc of [
      HEALTH_DESCRIPTOR,
      YIELD_DESCRIPTOR,
      ALERT_DESCRIPTOR,
      CLAIM_DESCRIPTOR,
    ]) {
      const result = buildWorkflow(desc);
      expect(result.nodes.length).toBeGreaterThan(0);
      expect(result.workflowType).toBe("read");
    }
  });
});

// ---------------------------------------------------------------------------
// WR-02: validateNoApproveTokenNode blocks any approve-token unconditionally
// ---------------------------------------------------------------------------

describe("PREFILL-06 WR-02: validateNoApproveTokenNode", () => {
  it("approve-token: validateNoApproveTokenNode is a function", () => {
    expect(typeof validateNoApproveTokenNode).toBe("function");
  });

  it("approve-token: node with amount 'max' is rejected", () => {
    const { valid, errors } = validateNoApproveTokenNode([APPROVE_NODE_MAX]);
    expect(valid).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("approve-token: node with exact (finite) amount is also rejected", () => {
    // Finite-amount approve-token passes validateNoMaxUint256Approval but must
    // be blocked here — any approve-token mutates state (PREFILL-06 / WR-02).
    const { valid, errors } = validateNoApproveTokenNode([APPROVE_NODE_EXACT]);
    expect(valid).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("approve-token: non-approve nodes pass the check", () => {
    const readNode: WorkflowNode = {
      id: "read-1",
      type: "action",
      position: { x: 100, y: 200 },
      data: {
        type: "action",
        label: "Read Contract",
        config: { actionType: "web3/read-contract", network: "1" },
        status: "idle",
      },
    };
    const { valid, errors } = validateNoApproveTokenNode([readNode]);
    expect(valid).toBe(true);
    expect(errors).toEqual([]);
  });

  it("approve-token: all current factory shapes pass (no shape emits approve-token)", () => {
    for (const desc of [
      HEALTH_DESCRIPTOR,
      YIELD_DESCRIPTOR,
      ALERT_DESCRIPTOR,
      CLAIM_DESCRIPTOR,
    ]) {
      const result = buildWorkflow(desc);
      const { valid } = validateNoApproveTokenNode(result.nodes);
      expect(valid).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Durable contract guard: real engine output → factory → no unresolved
// {{key}} placeholders (catches CR-01, CR-02 regressions) (WR-01 coverage)
// ---------------------------------------------------------------------------

// Representative ScanResponse that exercises all four suggestion categories.
const ARBITRUM_USDC_ADDR = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const WALLET_ADDR = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

const CONTRACT_SCAN: ScanResponse = {
  schemaVersion: 1,
  address: WALLET_ADDR,
  positions: [
    // health: Aave V3 position with active loan
    {
      chainId: 42_161,
      protocol: "aave-v3" as const,
      healthFactor: 1.8,
      noActiveLoan: false,
      totalCollateralUsd: 10_000,
      totalDebtUsd: 5000,
      suppliedAssets: [
        {
          symbol: "WETH",
          tokenAddress: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
          amount: "3000000000000000000",
          decimals: 18,
          usdValue: 10_000,
        },
      ],
      borrowedAssets: [
        {
          symbol: "USDC",
          tokenAddress: ARBITRUM_USDC_ADDR,
          amount: "5000000000",
          decimals: 6,
          usdValue: 5000,
        },
      ],
    },
    // alert: supply-only Aave position (no active loan, not lido)
    {
      chainId: 42_161,
      protocol: "aave-v3" as const,
      healthFactor: null,
      noActiveLoan: true,
      totalCollateralUsd: 500,
      totalDebtUsd: null,
      suppliedAssets: [
        {
          symbol: "USDC",
          tokenAddress: ARBITRUM_USDC_ADDR,
          amount: "500000000",
          decimals: 6,
          usdValue: 500,
        },
      ],
      borrowedAssets: [],
    },
    // claim: Lido position
    {
      chainId: 1,
      protocol: "lido" as const,
      healthFactor: null,
      noActiveLoan: true,
      totalCollateralUsd: 1000,
      totalDebtUsd: null,
      suppliedAssets: [
        {
          symbol: "stETH",
          tokenAddress: "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84",
          amount: "500000000000000000",
          decimals: 18,
          usdValue: 1200,
        },
      ],
      borrowedAssets: [],
    },
  ],
  // yield: non-depegged stablecoin above dust threshold
  stablecoins: [
    {
      chainId: 42_161,
      symbol: "USDC",
      tokenAddress: ARBITRUM_USDC_ADDR,
      amount: "500000000",
      decimals: 6,
      usdValue: 500,
      priceUsd: 1.0,
      depegged: false,
    },
  ],
  unavailableChains: [],
  scannedAt: new Date().toISOString(),
};

// ---------------------------------------------------------------------------
// PREFILL-08: Spark health descriptor → Spark pool address (not Aave pool)
// ---------------------------------------------------------------------------

const SPARK_HEALTH_DESCRIPTOR: SuggestionDescriptor = {
  id: "hf-monitor-spark-1",
  name: "Spark Health Factor Alert",
  description: "Monitor your Spark health factor on Ethereum.",
  category: "health",
  chainId: 1,
  readOrWrite: "read",
  protocol: "spark",
  usdValue: 4000,
  riskNote:
    "Read-only monitoring. This workflow does not make any transactions.",
  confirmInputs: {
    walletAddress: "Your wallet address to monitor",
    threshold: "1500000000000000000",
  },
};

describe("PREFILL-08: Spark health descriptor selects Spark pool, not Aave pool", () => {
  const SPARK_POOL_ADDRESS = "0xC13e21B648A5Ee794902342038FF3aDAB66BE987";
  const AAVE_V3_ETH_POOL = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";

  it("spark: read node targets the Spark pool address, not the Aave V3 Ethereum pool", () => {
    const result = buildWorkflow(SPARK_HEALTH_DESCRIPTOR);
    const readNode = result.nodes.find(
      (n) => n.data.config?.abiFunction === "getUserAccountData"
    );
    expect(readNode).toBeDefined();
    expect(readNode?.data.config?.contractAddress).toBe(SPARK_POOL_ADDRESS);
    expect(readNode?.data.config?.contractAddress).not.toBe(AAVE_V3_ETH_POOL);
  });

  it("spark: buildWorkflow passes all read-only factory guards without throwing", () => {
    const result = buildWorkflow(SPARK_HEALTH_DESCRIPTOR);
    expect(result.nodes).toHaveLength(4);
    const { valid: refsValid, errors: refErrors } = validateTemplateRefs(
      result.nodes,
      result.edges
    );
    expect(refErrors).toEqual([]);
    expect(refsValid).toBe(true);
    const { valid: noApprove } = validateNoApproveTokenNode(result.nodes);
    expect(noApprove).toBe(true);
    const { valid: noMaxUint } = validateNoMaxUint256Approval(result.nodes);
    expect(noMaxUint).toBe(true);
  });

  it("spark: condition hfRef resolves to the read node label (single-sourced, no drift)", () => {
    const result = buildWorkflow(SPARK_HEALTH_DESCRIPTOR);
    const readNode = result.nodes.find(
      (n) => n.data.config?.abiFunction === "getUserAccountData"
    );
    // validateTemplateRefs verifies the {{@readId:readLabel.field}} ref in the
    // condition leftOperand resolves against the actual read node label. If
    // readLabel in hfRef and readLabel in the node drift, this check fails.
    const { valid, errors } = validateTemplateRefs(result.nodes, result.edges);
    expect(errors).toEqual([]);
    expect(valid).toBe(true);
    expect(typeof readNode?.data.label).toBe("string");
    expect((readNode?.data.label ?? "").length).toBeGreaterThan(0);
  });

  it("regression: Aave health descriptor still targets the Aave V3 Arbitrum pool after Spark changes", () => {
    const result = buildWorkflow(HEALTH_DESCRIPTOR);
    const readNode = result.nodes.find(
      (n) => n.data.config?.abiFunction === "getUserAccountData"
    );
    // HEALTH_DESCRIPTOR uses chainId 42161 (Arbitrum) with protocol "aave-v3"
    expect(readNode?.data.config?.contractAddress).toBe(
      "0x794a61358D6845594F94dc1DB02A252b5b4814aD"
    );
    expect(readNode?.data.config?.contractAddress).not.toBe(SPARK_POOL_ADDRESS);
  });
});

describe("Contract: engine → factory → no unresolved {{key}} placeholders (CR-01, CR-02)", () => {
  it("all four categories covered by the scan fixture", () => {
    const descriptors = buildSuggestions(CONTRACT_SCAN);
    const categories = new Set(descriptors.map((d) => d.category));
    expect(categories).toContain("health");
    expect(categories).toContain("yield");
    expect(categories).toContain("alert");
    expect(categories).toContain("claim");
  });

  it("every engine-produced descriptor: buildWorkflow output has no unresolved {{key}} placeholder", () => {
    const descriptors = buildSuggestions(CONTRACT_SCAN);

    for (const descriptor of descriptors) {
      const workflow = buildWorkflow(descriptor);
      const workflowJson = JSON.stringify({
        nodes: workflow.nodes,
        edges: workflow.edges,
      });

      for (const match of workflowJson.matchAll(RE_SIMPLE_PLACEHOLDER)) {
        const key = match[1];
        expect(
          key in descriptor.confirmInputs,
          `Category "${descriptor.category}" (id: ${descriptor.id}): ` +
            `placeholder {{${key}}} has no matching key in confirmInputs. ` +
            `Available keys: ${Object.keys(descriptor.confirmInputs).join(", ")}`
        ).toBe(true);
      }
    }
  });

  it("alert descriptor: confirmInputs carries tokenAddress and alertThreshold (CR-01)", () => {
    const descriptors = buildSuggestions(CONTRACT_SCAN);
    const alert = descriptors.find((d) => d.category === "alert");
    expect(alert).toBeDefined();
    expect("tokenAddress" in (alert?.confirmInputs ?? {})).toBe(true);
    expect("alertThreshold" in (alert?.confirmInputs ?? {})).toBe(true);
    expect("priceThreshold" in (alert?.confirmInputs ?? {})).toBe(false);
  });

  it("claim descriptor: confirmInputs carries stakingTokenAddress (CR-02)", () => {
    const descriptors = buildSuggestions(CONTRACT_SCAN);
    const claim = descriptors.find((d) => d.category === "claim");
    expect(claim).toBeDefined();
    expect("stakingTokenAddress" in (claim?.confirmInputs ?? {})).toBe(true);
  });

  it("health descriptor: condition rightOperand matches the clamped threshold in confirmInputs (WR-01)", () => {
    const descriptors = buildSuggestions(CONTRACT_SCAN);
    const health = descriptors.find((d) => d.category === "health");
    expect(health).toBeDefined();

    const workflow = buildWorkflow(health as SuggestionDescriptor);
    const condNode = workflow.nodes.find(
      (n) => String(n.data.config?.actionType) === "Condition"
    );
    expect(condNode).toBeDefined();

    type ConditionGroup = {
      rules?: Array<{ rightOperand?: unknown }>;
    };
    type ConditionConfig = { group?: ConditionGroup } | undefined;
    const condConfig = condNode?.data.config
      ?.conditionConfig as ConditionConfig;
    const rightOperand = String(condConfig?.group?.rules?.[0]?.rightOperand);

    // rightOperand must equal the threshold in confirmInputs (description and condition agree)
    expect(rightOperand).toBe(health?.confirmInputs.threshold);
    // and must be a 19-digit 1e18-scale integer string
    expect(rightOperand).toMatch(RE_HF_1E18);
  });
});

// ---------------------------------------------------------------------------
// YIELD-04: yield workflow destination reference + read-only guard (57-01)
// ---------------------------------------------------------------------------

// YIELD_DESCRIPTOR variant with destinationAddress in confirmInputs.
// This is the shape the engine will produce in Wave 2 (57-02) when apyContext
// resolves a valid APY entry for the stablecoin.
const YIELD_DESCRIPTOR_WITH_DEST: SuggestionDescriptor = {
  ...YIELD_DESCRIPTOR,
  id: "yield-monitor-usdc-42161-apy",
  name: "USDC Idle Yield Monitor",
  description:
    "Monitor your USDC balance ($500) on Arbitrum. Earn ~4.2% APY via Aave V3 on Arbitrum.",
  confirmInputs: {
    walletAddress: "Your wallet address to monitor",
    tokenAddress: ARBITRUM_USDC,
    destinationAddress: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  },
};

describe("YIELD-04: yield workflow destination reference + read-only guard (57-01)", () => {
  it("destination-ref: buildWorkflow output JSON references the destinationAddress (RED — 57-03 wires it)", () => {
    const result = buildWorkflow(YIELD_DESCRIPTOR_WITH_DEST);
    const workflowJson = JSON.stringify({
      nodes: result.nodes,
      edges: result.edges,
    });
    // RED: factory does not yet embed destinationAddress in any node config.
    // 57-03 will modify stablecoin-yield.ts to surface it (e.g. in alert body).
    expect(workflowJson).toContain(
      YIELD_DESCRIPTOR_WITH_DEST.confirmInputs.destinationAddress
    );
  });

  it("read-only guard: validateNoApproveTokenNode passes on APY-aware yield workflow", () => {
    const result = buildWorkflow(YIELD_DESCRIPTOR_WITH_DEST);
    const { valid } = validateNoApproveTokenNode(result.nodes);
    // GREEN: stablecoin-yield.ts never emits approve-token nodes (YIELD-04 invariant)
    expect(valid).toBe(true);
  });

  it("read-only guard: validateNoMaxUint256Approval passes on APY-aware yield workflow", () => {
    const result = buildWorkflow(YIELD_DESCRIPTOR_WITH_DEST);
    const { valid } = validateNoMaxUint256Approval(result.nodes);
    // GREEN: no MaxUint256 approval possible in a read-only monitor (YIELD-04 invariant)
    expect(valid).toBe(true);
  });
});
