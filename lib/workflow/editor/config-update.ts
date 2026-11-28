import { clearUnsponsoredOnlyFields } from "@/lib/web3/unsponsored-only-fields";
import {
  type ActionConfigFieldBase,
  findActionById,
  flattenConfigFields,
  isFieldEnabled,
  isFieldShown,
} from "@/plugins/registry";

/** Shown and accepting input, as the form decides it. */
export function isFieldEditable(
  field: ActionConfigFieldBase,
  config: Record<string, unknown>
): boolean {
  return isFieldShown(field, config) && isFieldEnabled(field, config);
}

/**
 * Field updates made in the same tick (Send as sends `sendMode`, then
 * `usePrivateMempool`): `start` is the config before the first of them,
 * `merged` every value set since, before any clearing, and `cleared` the
 * labels of the fields the batch so far clears.
 */
export type ConfigUpdateBatch = {
  start: Record<string, unknown>;
  merged: Record<string, unknown>;
  cleared: readonly string[];
};

export const CLEARED_FIELDS_TOAST_ID = "unsponsored-fields-cleared";

// "Max Fee (gwei)" reads as "Max Fee" inside a sentence.
const LABEL_UNIT = /\s*\([^)]*\)$/;

/** The editor notice once a batch has cleared fields, so it is never silent. */
export function clearedFieldsNotice(labels: readonly string[]): string {
  const names = labels.map((label) => label.replace(LABEL_UNIT, ""));
  return `${names.join(" and ")} cleared: Sponsor gas is on, so the sponsor sets the fees. Turn off Sponsor gas to set them again.`;
}

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
 * so a midway state (sponsored after one write, not after the next) cannot
 * clear fees the final config still shows.
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
  const after = withFields(merged);
  const config = clearUnsponsoredOnlyFields(
    withFields(start),
    after,
    isFieldEditable
  );
  const cleared = after.fields
    .filter((field) => config[field.key] !== merged[field.key])
    .map((field) => field.label ?? field.key);
  return { batch: { start, merged, cleared }, config };
}

/**
 * A plugin field's value as the editor stores it: strings, booleans, plain
 * objects and undefined as they are, anything else as text.
 */
export function editorConfigValue(
  value: unknown
): string | boolean | Record<string, unknown> | undefined {
  if (
    typeof value === "string" ||
    typeof value === "boolean" ||
    value === undefined ||
    (typeof value === "object" && value !== null && !Array.isArray(value))
  ) {
    return value as string | boolean | Record<string, unknown> | undefined;
  }
  return String(value);
}
