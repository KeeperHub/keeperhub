/**
 * Stable workflow fixtures for the local-dev bootstrap.
 *
 * Each entry has a fixed `id` (so re-running dev-bootstrap.ts is an upsert,
 * not a fan-out) and a single trigger node — enough to cover the four trigger
 * types and the on/off + soft-deleted matrix without hauling in real plugin
 * actions. The shapes mirror the minimal trigger graphs produced by the
 * workflow builder UI.
 */

export type DevWorkflowFixture = {
  id: string;
  name: string;
  description: string;
  triggerType: "Manual" | "Schedule" | "Webhook" | "Event";
  enabled: boolean;
  softDeleted: boolean;
  triggerConfig: Record<string, unknown>;
};

const NODE_X = 100;
const NODE_Y = 200;

function manualConfig(): Record<string, unknown> {
  return { triggerType: "Manual" };
}

function scheduleConfig(): Record<string, unknown> {
  return { triggerType: "Schedule", scheduleCron: "0 * * * *" };
}

function webhookConfig(): Record<string, unknown> {
  return { triggerType: "Webhook" };
}

function eventConfig(): Record<string, unknown> {
  return {
    triggerType: "Event",
    network: "1",
    contractAddress: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    eventName: "Transfer",
  };
}

export const DEV_WORKFLOW_FIXTURES: DevWorkflowFixture[] = [
  {
    id: "dev_wf_manual_on",
    name: "[Dev] Manual Trigger (enabled)",
    description: "Manual trigger workflow, enabled. Local dev fixture.",
    triggerType: "Manual",
    enabled: true,
    softDeleted: false,
    triggerConfig: manualConfig(),
  },
  {
    id: "dev_wf_manual_off",
    name: "[Dev] Manual Trigger (disabled)",
    description: "Manual trigger workflow, disabled. Local dev fixture.",
    triggerType: "Manual",
    enabled: false,
    softDeleted: false,
    triggerConfig: manualConfig(),
  },
  {
    id: "dev_wf_schedule_on",
    name: "[Dev] Schedule Trigger (enabled)",
    description: "Hourly schedule, enabled. Local dev fixture.",
    triggerType: "Schedule",
    enabled: true,
    softDeleted: false,
    triggerConfig: scheduleConfig(),
  },
  {
    id: "dev_wf_schedule_off",
    name: "[Dev] Schedule Trigger (disabled)",
    description: "Hourly schedule, disabled. Local dev fixture.",
    triggerType: "Schedule",
    enabled: false,
    softDeleted: false,
    triggerConfig: scheduleConfig(),
  },
  {
    id: "dev_wf_webhook_on",
    name: "[Dev] Webhook Trigger (enabled)",
    description: "Webhook trigger, enabled. Local dev fixture.",
    triggerType: "Webhook",
    enabled: true,
    softDeleted: false,
    triggerConfig: webhookConfig(),
  },
  {
    id: "dev_wf_webhook_off",
    name: "[Dev] Webhook Trigger (disabled)",
    description: "Webhook trigger, disabled. Local dev fixture.",
    triggerType: "Webhook",
    enabled: false,
    softDeleted: false,
    triggerConfig: webhookConfig(),
  },
  {
    id: "dev_wf_event_on",
    name: "[Dev] Event Trigger (enabled)",
    description: "Event trigger on USDT Transfer, enabled. Local dev fixture.",
    triggerType: "Event",
    enabled: true,
    softDeleted: false,
    triggerConfig: eventConfig(),
  },
  {
    id: "dev_wf_soft_deleted",
    name: "[Dev] Soft-deleted Workflow",
    description: "Manual trigger workflow with deletedAt set. Local dev fixture.",
    triggerType: "Manual",
    enabled: false,
    softDeleted: true,
    triggerConfig: manualConfig(),
  },
];

export function buildTriggerNodes(
  fixture: DevWorkflowFixture
): { nodes: unknown[]; edges: unknown[] } {
  const nodes = [
    {
      id: "trigger-1",
      type: "trigger",
      position: { x: NODE_X, y: NODE_Y },
      data: {
        label: `${fixture.triggerType} Trigger`,
        type: "trigger",
        config: fixture.triggerConfig,
        status: "idle",
      },
    },
  ];
  return { nodes, edges: [] };
}
