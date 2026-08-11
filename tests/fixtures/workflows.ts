import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow/store";

/**
 * Creates a trigger node with schedule configuration
 */
export function createScheduleTriggerNode(
  cronExpression = "0 9 * * *",
  timezone = "UTC"
): WorkflowNode {
  return {
    id: "trigger-1",
    type: "trigger",
    position: { x: 100, y: 100 },
    data: {
      type: "trigger",
      label: "Schedule Trigger",
      config: {
        triggerType: "Schedule",
        scheduleCron: cronExpression,
        scheduleTimezone: timezone,
      },
    },
  };
}

/**
 * Creates a trigger node with webhook configuration
 */
export function createWebhookTriggerNode(): WorkflowNode {
  return {
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
  };
}

/**
 * Creates a trigger node with manual configuration
 */
export function createManualTriggerNode(): WorkflowNode {
  return {
    id: "trigger-1",
    type: "trigger",
    position: { x: 100, y: 100 },
    data: {
      type: "trigger",
      label: "Manual Trigger",
      config: {
        triggerType: "Manual",
      },
    },
  };
}

/**
 * Creates a simple action node
 */
export function createActionNode(
  id = "action-1",
  actionType = "HTTP Request",
  endpoint = "https://httpbin.org/post"
): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 300, y: 100 },
    data: {
      type: "action",
      label: "HTTP Request",
      config: {
        actionType,
        endpoint,
        httpMethod: "POST",
        httpHeaders: "{}",
        httpBody: "{}",
      },
    },
  };
}

/**
 * Creates an edge between two nodes
 */
export function createEdge(
  source: string,
  target: string,
  id?: string
): WorkflowEdge {
  return {
    id: id || `edge-${source}-${target}`,
    source,
    target,
    type: "default",
  };
}

/**
 * Creates a complete workflow with schedule trigger
 */
export function createScheduledWorkflow(
  cronExpression = "0 9 * * *",
  timezone = "UTC"
): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
  const triggerNode = createScheduleTriggerNode(cronExpression, timezone);
  const actionNode = createActionNode();
  const edge = createEdge(triggerNode.id, actionNode.id);

  return {
    nodes: [triggerNode, actionNode],
    edges: [edge],
  };
}

/**
 * Creates a complete workflow with manual trigger
 */
export function createManualWorkflow(actionEndpoint?: string): {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
} {
  const triggerNode = createManualTriggerNode();
  const actionNode = createActionNode(
    "action-1",
    "HTTP Request",
    actionEndpoint
  );
  const edge = createEdge(triggerNode.id, actionNode.id);

  return {
    nodes: [triggerNode, actionNode],
    edges: [edge],
  };
}

/**
 * Creates a complete workflow with webhook trigger
 */
export function createWebhookWorkflow(): {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
} {
  const triggerNode = createWebhookTriggerNode();
  const actionNode = createActionNode();
  const edge = createEdge(triggerNode.id, actionNode.id);

  return {
    nodes: [triggerNode, actionNode],
    edges: [edge],
  };
}

/**
 * Various cron expression test cases
 */
export const cronExpressions = {
  everyMinute: "* * * * *",
  everyHour: "0 * * * *",
  everyDayAt9am: "0 9 * * *",
  everyMondayAt9am: "0 9 * * 1",
  everyWeekdayAt9am: "0 9 * * 1-5",
  firstOfMonth: "0 0 1 * *",
  lastDayOfMonth: "0 0 L * *", // Note: L is not standard, may not work
  every5Minutes: "*/5 * * * *",
  every15Minutes: "*/15 * * * *",
  twiceDaily: "0 9,17 * * *",
  invalid: {
    tooFewFields: "* * *",
    tooManyFields: "* * * * * * *",
    invalidMinute: "60 * * * *",
    invalidHour: "0 25 * * *",
    invalidDay: "0 0 32 * *",
    invalidMonth: "0 0 * 13 *",
    invalidWeekday: "0 0 * * 8",
    notACron: "not a cron expression",
    empty: "",
  },
};

/**
 * Various timezone test cases
 */
export const timezones = {
  valid: [
    "UTC",
    "America/New_York",
    "America/Los_Angeles",
    "Europe/London",
    "Europe/Paris",
    "Asia/Tokyo",
    "Australia/Sydney",
  ],
  invalid: ["Invalid/Timezone", "Not/Real", "INVALID", ""],
};
