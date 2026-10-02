import type { ConditionGroup } from "./builder-types";
import { visualConditionToExpression } from "./expression";

// What a group with no usable rule generates: an empty or half-typed builder, not a gate.
const ALWAYS_TRUE = "true";

/**
 * Resolve the executable condition expression from a node's config.
 * Handles both visual builder configs and raw expression strings.
 *
 * Priority:
 * 1. conditionConfig.group with at least one usable rule -> generate expression from it
 * 2. condition string exists -> use as-is
 * 3. Neither -> return undefined (caller decides how to handle)
 *
 * A group whose rules are all blank generates "true", an always-open gate, and that is the
 * shape of every empty builder and every autosave taken mid-edit. The group stays on disk;
 * it just does not become a gate. The editor writes `condition` from the group it is
 * showing, so an always-true string beside a group is derived from it, not authored, and
 * cannot stand in for it either. handleModeSwitch clears `conditionConfig` when the author
 * deliberately moves to expression mode, so a bare "true" with no group is authored and is
 * still honoured.
 */
export function resolveConditionExpression(
  config: Record<string, unknown> | undefined
): string | undefined {
  if (!config) {
    return undefined;
  }

  const condition = config.condition;
  const authored =
    typeof condition === "string" && condition.trim() ? condition : undefined;

  const conditionConfig = config.conditionConfig as
    | { group: ConditionGroup }
    | undefined;

  if (conditionConfig?.group) {
    const expression = visualConditionToExpression(conditionConfig.group);
    if (expression !== ALWAYS_TRUE) {
      return expression;
    }
    return authored?.trim() === ALWAYS_TRUE ? undefined : authored;
  }

  return authored;
}
