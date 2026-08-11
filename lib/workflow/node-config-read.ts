type UnknownRecord = Record<string, unknown>;

export function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null
    ? (value as UnknownRecord)
    : null;
}

/**
 * Read a node-config field, preferring `data.config.<field>` but falling back
 * to the legacy top-level `data.<field>`.
 */
export function readNodeConfigField(
  data: UnknownRecord | null,
  config: UnknownRecord | null,
  field: string
): unknown {
  const fromConfig = config?.[field];
  return fromConfig === undefined ? data?.[field] : fromConfig;
}

/**
 * Normalize colon-separated action types (`code:run-code`) to the slash form
 * (`code/run-code`).
 */
export function normalizeActionType(value: unknown): string | undefined {
  return typeof value === "string" ? value.replace(":", "/") : undefined;
}
