import type { ActionConfigField } from "@/plugins/registry";

/**
 * The chain type an action's Network field is restricted to (its
 * `chain-select` field's `chainTypeFilter`), or undefined when the action has no
 * chain-type requirement. Looks inside field groups as well as top-level fields.
 */
export function actionRequiredChainType(
  configFields: readonly ActionConfigField[] | undefined
): string | string[] | undefined {
  for (const field of configFields ?? []) {
    if (field.type === "group") {
      for (const inner of field.fields) {
        if (inner.type === "chain-select" && inner.chainTypeFilter) {
          return inner.chainTypeFilter;
        }
      }
    } else if (field.type === "chain-select" && field.chainTypeFilter) {
      return field.chainTypeFilter;
    }
  }
  return undefined;
}

/**
 * Drops actions whose Network field is restricted to a chain type that has no
 * enabled chains, so the builder palette never offers a node the user cannot
 * run - e.g. the Solana-only Transfer SPL Token node when no Solana chain is
 * enabled. Actions without a chain-type requirement are always kept.
 *
 * Call this only once the enabled chain types are known; while they are still
 * loading, show every action (fail open) rather than briefly hiding chain
 * actions.
 */
export function filterActionsByAvailableChainTypes<
  T extends { configFields?: readonly ActionConfigField[] },
>(actions: readonly T[], enabledChainTypes: ReadonlySet<string>): T[] {
  return actions.filter((action) => {
    const required = actionRequiredChainType(action.configFields);
    if (required === undefined) {
      return true;
    }
    const requiredTypes = Array.isArray(required) ? required : [required];
    return requiredTypes.some((type) => enabledChainTypes.has(type));
  });
}
