// The trigger config fields a sidebar row shows (icon, label, tooltip). Kept
// free of imports so the API client can use it without an import cycle.
const DISPLAYED_CONFIG_KEYS = [
  "triggerType",
  "scheduleCron",
  "scheduleIntervalSeconds",
  "scheduleTimezone",
  "eventName",
  "blockInterval",
] as const;

/**
 * A string that changes only when what a sidebar row shows for this trigger
 * config changes. No trigger node at all reads differently from an empty one.
 */
export function triggerDisplayKey(config: unknown): string {
  if (config === undefined || config === null || typeof config !== "object") {
    return "none";
  }
  const fields = config as Record<string, unknown>;
  return JSON.stringify(
    DISPLAYED_CONFIG_KEYS.map((key) => fields[key] ?? null)
  );
}
