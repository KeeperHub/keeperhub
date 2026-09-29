import type { ConditionGroup } from "@/lib/workflow/nodes/condition/builder-types";

/**
 * Lean JSONB-shaped types for workflow nodes and edges. Intentionally narrower
 * than `WorkflowNode` / `WorkflowEdge` from `lib/workflow/store.ts`, which
 * pull in `@xyflow/react` and are only usable in client-side code. These types
 * are safe to import from scripts, seeders, server routes, and tests alike.
 *
 * `data.config` is `Record<string, unknown>` because each plugin action carries
 * a different config shape; callers narrow at the point of use.
 */
export type WorkflowNodeJson = {
  id: string;
  type?: string;
  position: { x: number; y: number };
  data: {
    label?: string;
    description?: string;
    type?: string;
    config?: Record<string, unknown>;
    status?: string;
  };
};

export type WorkflowEdgeJson = {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  label?: string;
};

export function buildProtocolMeta(
  protocolSlug: string,
  contractKey: string,
  functionName: string,
  actionType: "read" | "write"
): string {
  return JSON.stringify({
    protocolSlug,
    contractKey,
    functionName,
    actionType,
  });
}

export function buildTriggerNode(
  id: string,
  config: Record<string, unknown>
): WorkflowNodeJson {
  return {
    id,
    type: "trigger",
    position: { x: 100, y: 200 },
    data: { label: "Trigger", type: "trigger", config, status: "idle" },
  };
}

export function buildActionNode(
  id: string,
  label: string,
  description: string,
  config: Record<string, unknown>,
  yOffset: number
): WorkflowNodeJson {
  return {
    id,
    type: "action",
    position: { x: 100, y: yOffset },
    data: { label, description, type: "action", config, status: "idle" },
  };
}

export type ConditionNodeConfig = {
  condition: string;
  group: ConditionGroup;
};

export function buildConditionNode(
  id: string,
  conditionConfig: ConditionNodeConfig,
  yOffset: number
): WorkflowNodeJson {
  return {
    id,
    type: "action",
    position: { x: 100, y: yOffset },
    data: {
      label: "Condition",
      type: "action",
      config: {
        actionType: "Condition",
        condition: conditionConfig.condition,
        // The runtime reads the rule group from `conditionConfig`, and
        // `processActionConfig` lifts only `condition` and `conditionConfig` out
        // before rendering templates. A top-level `group` is therefore never read,
        // and its rules array carries unrendered tokens into the leftover-literal
        // scan, which aborts the run. `lib/scan/factory/node-builders.ts` has always
        // emitted the nested shape; this builder is the one that drifted.
        conditionConfig: { group: conditionConfig.group },
      },
      status: "idle",
    },
  };
}

export function buildDiscordNode(
  id: string,
  message: string,
  yOffset: number
): WorkflowNodeJson {
  return buildActionNode(
    id,
    "Send Discord Alert",
    "Send a notification to a Discord channel",
    {
      actionType: "discord/send-message",
      integrationId: "",
      discordMessage: message,
    },
    yOffset
  );
}

export function buildEmailNode(
  id: string,
  subject: string,
  body: string,
  yOffset: number
): WorkflowNodeJson {
  return buildActionNode(
    id,
    "Send Email Alert",
    "Send an email notification",
    {
      actionType: "sendgrid/send-email",
      useKeeperHubApiKey: true,
      emailTo: "",
      emailSubject: subject,
      emailBody: body,
    },
    yOffset
  );
}

export function buildEdge(
  source: string,
  target: string,
  sourceHandle?: string
): WorkflowEdgeJson {
  if (sourceHandle !== undefined) {
    return { id: `e-${source}-${target}`, source, target, sourceHandle };
  }
  return { id: `e-${source}-${target}`, source, target };
}
