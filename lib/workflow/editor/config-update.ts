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

function withFields(config: Record<string, unknown>): {
  config: Record<string, unknown>;
  fields: ReturnType<typeof flattenConfigFields>;
} {
  const action =
    typeof config.actionType === "string"
      ? findActionById(config.actionType)
      : undefined;
  return {
    config,
    fields: action?.configFields
      ? flattenConfigFields(action.configFields)
      : [],
  };
}

/**
 * One editor field update. `prepare` reshapes the merged config (an action
 * type change prunes and seeds it). The whole batch is judged from its start,
 * so a midway state (sponsored after `network`, not after
 * `usePrivateMempool`) cannot clear fees the final config still shows.
 */
export function applyConfigUpdate(
  batch: ConfigUpdateBatch | null,
  current: Record<string, unknown>,
  key: string,
  value: unknown,
  prepare?: (config: Record<string, unknown>) => Record<string, unknown>
): { batch: ConfigUpdateBatch; config: Record<string, unknown> } {
  const start = batch?.start ?? current;
  const raw = { ...(batch?.merged ?? current), [key]: value };
  const merged = prepare ? prepare(raw) : raw;
  return {
    batch: { start, merged },
    config: clearUnsponsoredOnlyFields(withFields(start), withFields(merged)),
  };
}
