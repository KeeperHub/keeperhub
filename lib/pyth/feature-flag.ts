import { findPythTriggerNode } from "./trigger-config";

export function isPythPriceTriggerEnabled(): boolean {
  return Boolean(process.env.PYTH_API_KEY?.trim());
}

export function hasPythPriceTrigger(nodes: unknown): boolean {
  return findPythTriggerNode(nodes) !== null;
}
