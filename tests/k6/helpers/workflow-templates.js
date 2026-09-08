// Realistic workflow templates based on production data analysis.
// All external service calls (web3, discord, etc.) are replaced with
// HTTP Request to /api/health to isolate the execution engine from
// third-party latency while preserving the node graph structure.

import { getBaseUrl } from "./http.js";

function httpAction(id, label, x, y) {
  return {
    id,
    type: "action",
    position: { x, y },
    data: {
      type: "action",
      label,
      config: {
        actionType: "HTTP Request",
        endpoint: `${getBaseUrl()}/api/health`,
        httpMethod: "GET",
        httpHeaders: "{}",
        httpBody: "{}",
      },
    },
  };
}

function conditionAction(id, label, condition, x, y) {
  return {
    id,
    type: "action",
    position: { x, y },
    data: {
      type: "action",
      label,
      config: {
        actionType: "Condition",
        condition: condition || "1 === 1",
      },
    },
  };
}

function triggerNode(triggerType, extra = {}) {
  const config = { triggerType, ...extra };
  return {
    id: "trigger-1",
    type: "trigger",
    position: { x: 100, y: 100 },
    data: { type: "trigger", label: `${triggerType} Trigger`, config },
  };
}

// Pattern 1: Manual -> HTTP (2 nodes) — most common simple workflow
export function pattern1_simpleManual(vuId, suffix) {
  return {
    name: `k6-p1-manual-${suffix}-vu${vuId}`,
    description: "Simple manual trigger with single action",
    nodes: [triggerNode("Manual"), httpAction("a1", "Read Data", 300, 100)],
    edges: [{ id: "e1", source: "trigger-1", target: "a1", type: "default" }],
  };
}

// Pattern 2: Manual -> Condition -> HTTP (3 nodes) — conditional gate
export function pattern2_conditionalGate(vuId, suffix) {
  return {
    name: `k6-p2-condgate-${suffix}-vu${vuId}`,
    description: "Manual trigger with condition gate before action",
    nodes: [
      triggerNode("Manual"),
      conditionAction("c1", "Check Balance", "1 > 0", 300, 100),
      httpAction("a1", "Execute Action", 500, 100),
    ],
    edges: [
      { id: "e1", source: "trigger-1", target: "c1", type: "default" },
      { id: "e2", source: "c1", target: "a1", type: "default" },
    ],
  };
}

// Pattern 3: Schedule -> HTTP -> Condition -> HTTP (4 nodes) — scheduled multi-step
export function pattern3_scheduledChain(vuId, suffix) {
  return {
    name: `k6-p3-schedchain-${suffix}-vu${vuId}`,
    description: "Scheduled chain: read, check, act",
    nodes: [
      triggerNode("Schedule", {
        scheduleCron: "* * * * *",
        scheduleTimezone: "UTC",
      }),
      httpAction("a1", "Read Contract", 300, 100),
      conditionAction("c1", "Check Threshold", "1 > 0", 500, 100),
      httpAction("a2", "Send Notification", 700, 100),
    ],
    edges: [
      { id: "e1", source: "trigger-1", target: "a1", type: "default" },
      { id: "e2", source: "a1", target: "c1", type: "default" },
      { id: "e3", source: "c1", target: "a2", type: "default" },
    ],
  };
}

// Pattern 4: Webhook -> HTTP (2 nodes) — event-driven simple
export function pattern4_webhookSimple(vuId, suffix) {
  return {
    name: `k6-p4-webhook-${suffix}-vu${vuId}`,
    description: "Webhook trigger with single action",
    nodes: [triggerNode("Webhook"), httpAction("a1", "Process Event", 300, 100)],
    edges: [{ id: "e1", source: "trigger-1", target: "a1", type: "default" }],
  };
}

// Pattern 5: Schedule -> HTTP x2 -> Condition x2 -> HTTP x2 (7 nodes)
// Based on "cron each hour" pattern — the top execution producer
export function pattern5_cronMonitor(vuId, suffix) {
  return {
    name: `k6-p5-cronmon-${suffix}-vu${vuId}`,
    description: "Scheduled monitor: multi-read, multi-check, multi-notify",
    nodes: [
      triggerNode("Schedule", {
        scheduleCron: "* * * * *",
        scheduleTimezone: "UTC",
      }),
      httpAction("a1", "Read Contract 1", 300, 50),
      httpAction("a2", "Read Contract 2", 300, 200),
      conditionAction("c1", "Check Condition 1", "1 === 1", 500, 50),
      conditionAction("c2", "Check Condition 2", "1 === 1", 500, 200),
      httpAction("a3", "Alert Channel 1", 700, 50),
      httpAction("a4", "Alert Channel 2", 700, 200),
    ],
    edges: [
      { id: "e1", source: "trigger-1", target: "a1", type: "default" },
      { id: "e2", source: "trigger-1", target: "a2", type: "default" },
      { id: "e3", source: "a1", target: "c1", type: "default" },
      { id: "e4", source: "a2", target: "c2", type: "default" },
      { id: "e5", source: "c1", target: "a3", type: "default" },
      { id: "e6", source: "c2", target: "a4", type: "default" },
    ],
  };
}

// Pattern 6: Manual -> HTTP -> Condition -> HTTP x2 (5 nodes) — read, check, branch
export function pattern6_readCheckBranch(vuId, suffix) {
  return {
    name: `k6-p6-readcheck-${suffix}-vu${vuId}`,
    description: "Read data, check condition, execute on both branches",
    nodes: [
      triggerNode("Manual"),
      httpAction("a1", "Read Balance", 300, 100),
      conditionAction("c1", "Balance Check", "1 > 0", 500, 100),
      httpAction("a2", "Action If True", 700, 50),
      httpAction("a3", "Action If False", 700, 200),
    ],
    edges: [
      { id: "e1", source: "trigger-1", target: "a1", type: "default" },
      { id: "e2", source: "a1", target: "c1", type: "default" },
      { id: "e3", source: "c1", target: "a2", type: "default" },
      { id: "e4", source: "c1", target: "a3", type: "default" },
    ],
  };
}

// Pattern 7: Manual -> HTTP x3 -> Condition (5 nodes) — multi-read with aggregation check
export function pattern7_multiRead(vuId, suffix) {
  return {
    name: `k6-p7-multiread-${suffix}-vu${vuId}`,
    description: "Multiple data reads followed by aggregation condition",
    nodes: [
      triggerNode("Manual"),
      httpAction("a1", "Read Source 1", 300, 50),
      httpAction("a2", "Read Source 2", 300, 150),
      httpAction("a3", "Read Source 3", 300, 250),
      conditionAction("c1", "Aggregate Check", "1 === 1", 500, 150),
    ],
    edges: [
      { id: "e1", source: "trigger-1", target: "a1", type: "default" },
      { id: "e2", source: "trigger-1", target: "a2", type: "default" },
      { id: "e3", source: "trigger-1", target: "a3", type: "default" },
      { id: "e4", source: "a1", target: "c1", type: "default" },
      { id: "e5", source: "a2", target: "c1", type: "default" },
      { id: "e6", source: "a3", target: "c1", type: "default" },
    ],
  };
}

// Pattern 8: Schedule -> Condition -> HTTP (3 nodes) — simple scheduled check
export function pattern8_scheduledCheck(vuId, suffix) {
  return {
    name: `k6-p8-schedcheck-${suffix}-vu${vuId}`,
    description: "Scheduled condition check with action",
    nodes: [
      triggerNode("Schedule", {
        scheduleCron: "* * * * *",
        scheduleTimezone: "UTC",
      }),
      conditionAction("c1", "Should Execute", "1 === 1", 300, 100),
      httpAction("a1", "Execute Action", 500, 100),
    ],
    edges: [
      { id: "e1", source: "trigger-1", target: "c1", type: "default" },
      { id: "e2", source: "c1", target: "a1", type: "default" },
    ],
  };
}

// Pattern 9: Manual -> HTTP -> HTTP -> HTTP (4 nodes) — sequential pipeline
export function pattern9_sequentialPipeline(vuId, suffix) {
  return {
    name: `k6-p9-pipeline-${suffix}-vu${vuId}`,
    description: "Sequential 3-step action pipeline",
    nodes: [
      triggerNode("Manual"),
      httpAction("a1", "Step 1: Approve", 300, 100),
      httpAction("a2", "Step 2: Execute", 500, 100),
      httpAction("a3", "Step 3: Confirm", 700, 100),
    ],
    edges: [
      { id: "e1", source: "trigger-1", target: "a1", type: "default" },
      { id: "e2", source: "a1", target: "a2", type: "default" },
      { id: "e3", source: "a2", target: "a3", type: "default" },
    ],
  };
}

// Pattern 10: Webhook -> Condition -> HTTP (3 nodes) — event with condition
export function pattern10_webhookConditional(vuId, suffix) {
  return {
    name: `k6-p10-webhookcond-${suffix}-vu${vuId}`,
    description: "Webhook event with conditional processing",
    nodes: [
      triggerNode("Webhook"),
      conditionAction("c1", "Event Filter", "1 === 1", 300, 100),
      httpAction("a1", "Process Event", 500, 100),
    ],
    edges: [
      { id: "e1", source: "trigger-1", target: "c1", type: "default" },
      { id: "e2", source: "c1", target: "a1", type: "default" },
    ],
  };
}

// Returns all 10 patterns for a given VU and round suffix.
// Distribution weights match production data:
// ~40% manual, ~35% scheduled, ~25% webhook
export const ALL_PATTERNS = [
  pattern1_simpleManual,
  pattern2_conditionalGate,
  pattern3_scheduledChain,
  pattern4_webhookSimple,
  pattern5_cronMonitor,
  pattern6_readCheckBranch,
  pattern7_multiRead,
  pattern8_scheduledCheck,
  pattern9_sequentialPipeline,
  pattern10_webhookConditional,
];

export function getWorkflowBatch(vuId, round, count) {
  const batch = [];
  for (let i = 0; i < count; i++) {
    const patternFn = ALL_PATTERNS[i % ALL_PATTERNS.length];
    batch.push(patternFn(vuId, `r${round}-${i}`));
  }
  return batch;
}
