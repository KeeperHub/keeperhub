import { getBaseUrl } from "./http.js";

export function simpleManualWorkflow(vuId) {
  return {
    name: `k6-simple-manual-vu${vuId}`,
    description: "Simple manual trigger with health check",
    nodes: [
      {
        id: "trigger-1",
        type: "trigger",
        position: { x: 100, y: 100 },
        data: {
          type: "trigger",
          label: "Manual Trigger",
          config: { triggerType: "Manual" },
        },
      },
      {
        id: "action-1",
        type: "action",
        position: { x: 300, y: 100 },
        data: {
          type: "action",
          label: "Health Check",
          config: {
            actionType: "HTTP Request",
            endpoint: `${getBaseUrl()}/api/health`,
            httpMethod: "GET",
            httpHeaders: "{}",
            httpBody: "{}",
          },
        },
      },
    ],
    edges: [
      { id: "e1", source: "trigger-1", target: "action-1", type: "default" },
    ],
  };
}

export function conditionalWorkflow(vuId) {
  return {
    name: `k6-conditional-vu${vuId}`,
    description: "Manual trigger with condition gate",
    nodes: [
      {
        id: "trigger-1",
        type: "trigger",
        position: { x: 100, y: 100 },
        data: {
          type: "trigger",
          label: "Manual Trigger",
          config: { triggerType: "Manual" },
        },
      },
      {
        id: "condition-1",
        type: "action",
        position: { x: 300, y: 100 },
        data: {
          type: "action",
          label: "Always True",
          config: {
            actionType: "Condition",
            condition: "1 === 1",
          },
        },
      },
      {
        id: "action-1",
        type: "action",
        position: { x: 500, y: 100 },
        data: {
          type: "action",
          label: "Health Check",
          config: {
            actionType: "HTTP Request",
            endpoint: `${getBaseUrl()}/api/health`,
            httpMethod: "GET",
            httpHeaders: "{}",
            httpBody: "{}",
          },
        },
      },
    ],
    edges: [
      {
        id: "e1",
        source: "trigger-1",
        target: "condition-1",
        type: "default",
      },
      {
        id: "e2",
        source: "condition-1",
        target: "action-1",
        type: "default",
      },
    ],
  };
}

export function multiStepWorkflow(vuId) {
  return {
    name: `k6-multistep-vu${vuId}`,
    description: "Multi-step chain with condition",
    nodes: [
      {
        id: "trigger-1",
        type: "trigger",
        position: { x: 100, y: 100 },
        data: {
          type: "trigger",
          label: "Manual Trigger",
          config: { triggerType: "Manual" },
        },
      },
      {
        id: "action-1",
        type: "action",
        position: { x: 300, y: 100 },
        data: {
          type: "action",
          label: "First Request",
          config: {
            actionType: "HTTP Request",
            endpoint: `${getBaseUrl()}/api/health`,
            httpMethod: "GET",
            httpHeaders: "{}",
            httpBody: "{}",
          },
        },
      },
      {
        id: "condition-1",
        type: "action",
        position: { x: 500, y: 100 },
        data: {
          type: "action",
          label: "Check Result",
          config: {
            actionType: "Condition",
            condition: "1 === 1",
          },
        },
      },
      {
        id: "action-2",
        type: "action",
        position: { x: 700, y: 100 },
        data: {
          type: "action",
          label: "Second Request",
          config: {
            actionType: "HTTP Request",
            endpoint: `${getBaseUrl()}/api/health`,
            httpMethod: "GET",
            httpHeaders: "{}",
            httpBody: "{}",
          },
        },
      },
    ],
    edges: [
      {
        id: "e1",
        source: "trigger-1",
        target: "action-1",
        type: "default",
      },
      {
        id: "e2",
        source: "action-1",
        target: "condition-1",
        type: "default",
      },
      {
        id: "e3",
        source: "condition-1",
        target: "action-2",
        type: "default",
      },
    ],
  };
}

export function scheduledWorkflow(vuId) {
  return {
    name: `k6-scheduled-vu${vuId}`,
    description: "Schedule trigger (far future, not executed)",
    nodes: [
      {
        id: "trigger-1",
        type: "trigger",
        position: { x: 100, y: 100 },
        data: {
          type: "trigger",
          label: "Schedule Trigger",
          config: {
            triggerType: "Schedule",
            scheduleCron: "0 0 1 1 *",
            scheduleTimezone: "UTC",
          },
        },
      },
      {
        id: "action-1",
        type: "action",
        position: { x: 300, y: 100 },
        data: {
          type: "action",
          label: "Health Check",
          config: {
            actionType: "HTTP Request",
            endpoint: `${getBaseUrl()}/api/health`,
            httpMethod: "GET",
            httpHeaders: "{}",
            httpBody: "{}",
          },
        },
      },
    ],
    edges: [
      { id: "e1", source: "trigger-1", target: "action-1", type: "default" },
    ],
  };
}

export function webhookWorkflow(vuId) {
  return {
    name: `k6-webhook-vu${vuId}`,
    description: "Webhook trigger with health check action",
    nodes: [
      {
        id: "trigger-1",
        type: "trigger",
        position: { x: 100, y: 100 },
        data: {
          type: "trigger",
          label: "Webhook Trigger",
          config: {
            triggerType: "Webhook",
          },
        },
      },
      {
        id: "action-1",
        type: "action",
        position: { x: 300, y: 100 },
        data: {
          type: "action",
          label: "Health Check",
          config: {
            actionType: "HTTP Request",
            endpoint: `${getBaseUrl()}/api/health`,
            httpMethod: "GET",
            httpHeaders: "{}",
            httpBody: "{}",
          },
        },
      },
    ],
    edges: [
      { id: "e1", source: "trigger-1", target: "action-1", type: "default" },
    ],
  };
}

export function getAllWorkflowPayloads(vuId) {
  return [
    simpleManualWorkflow(vuId),
    conditionalWorkflow(vuId),
    multiStepWorkflow(vuId),
    scheduledWorkflow(vuId),
    webhookWorkflow(vuId),
  ];
}
