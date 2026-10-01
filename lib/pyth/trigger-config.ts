import { createHash } from "node:crypto";
import {
  type PythTriggerConfig,
  parsePythTriggerConfig,
} from "./price-trigger";

export function hashPythConfig(config: PythTriggerConfig): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

/**
 * The single definition of "this workflow has a Pyth trigger": the first
 * trigger node, when its triggerType is Pyth Price. Registration, the
 * feature gate and MCP validation all resolve the node through here, so they
 * cannot disagree about which node counts.
 */
export function findPythTriggerNode(
  nodes: unknown
): { index: number; config: Record<string, unknown> } | null {
  if (!Array.isArray(nodes)) {
    return null;
  }
  const index = nodes.findIndex((node) => node?.data?.type === "trigger");
  const config = index === -1 ? undefined : nodes[index].data.config;
  return config?.triggerType === "Pyth Price" ? { index, config } : null;
}

export function findPythConfig(nodes: unknown): PythTriggerConfig | null {
  const trigger = findPythTriggerNode(nodes);
  return trigger ? parsePythTriggerConfig(trigger.config) : null;
}
