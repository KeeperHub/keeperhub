import type { ConditionGroup } from "./builder-types";
import { visualConditionToExpression } from "./expression";

/**
 * Resolve the executable condition expression from a node's config.
 * Handles both visual builder configs and raw expression strings.
 *
 * Priority:
 * 1. conditionConfig.group exists -> generate expression from visual config
 * 2. condition string exists -> use as-is
 * 3. Neither -> return undefined (caller decides how to handle)
 */
export function resolveConditionExpression(
  config: Record<string, unknown> | undefined
): string | undefined {
  if (!config) {
    return undefined;
  }

  const conditionConfig = config.conditionConfig as
    | { group: ConditionGroup }
    | undefined;

  if (conditionConfig?.group) {
    return visualConditionToExpression(conditionConfig.group);
  }

  const condition = config.condition;
  if (typeof condition === "string" && condition.trim()) {
    return condition;
  }

  return undefined;
}
