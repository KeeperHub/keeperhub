import { createHash } from "node:crypto";
import {
  type PythTriggerConfig,
  parsePythTriggerConfig,
} from "./price-trigger";

export function hashPythConfig(config: PythTriggerConfig): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

export function findPythConfig(nodes: unknown): PythTriggerConfig | null {
  if (!Array.isArray(nodes)) {
    return null;
  }
  const trigger = nodes.find((node) => node?.data?.type === "trigger");
  if (trigger?.data?.config?.triggerType !== "Pyth Price") {
    return null;
  }
  return parsePythTriggerConfig(trigger.data.config);
}
