import { clearUnsponsoredOnlyFields } from "@/lib/web3/unsponsored-only-fields";
import { findActionById, flattenConfigFields } from "@/plugins/registry";

/**
 * Field updates made in the same tick (the network select sends `network`,
 * then `usePrivateMempool`): `start` is the config before the first of them,
 * `merged` every value set since, before any clearing.
 */
export type ConfigUpdateBatch = {
  start: Record<string, unknown>;
  merged: Record<string, unknown>;
};

/**
 * One editor field update. The whole batch is judged from its start, so a
 * midway state (sponsored after `network`, not after `usePrivateMempool`)
 * cannot clear fees the final config still shows.
 */
export function applyConfigUpdate(
  batch: ConfigUpdateBatch | null,
  current: Record<string, unknown>,
  key: string,
  value: unknown
): { batch: ConfigUpdateBatch; config: Record<string, unknown> } {
  const start = batch?.start ?? current;
  const merged = { ...(batch?.merged ?? current), [key]: value };
  const action =
    typeof merged.actionType === "string"
      ? findActionById(merged.actionType)
      : undefined;
  const fields = action?.configFields
    ? flattenConfigFields(action.configFields)
    : [];
  return {
    batch: { start, merged },
    config: clearUnsponsoredOnlyFields(start, merged, fields),
  };
}
