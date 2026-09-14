/**
 * Trace trigger config shared by the editor and the events worker endpoint.
 *
 * The event tracker validates every field again at map time
 * (keeperhub-events/event-tracker/src/listener/workflow-mapper.ts) and refuses
 * a workflow whose filter it cannot read. This module only reconciles the
 * shape the editor stores with the shape the tracker expects.
 */

/** Frame types the tracker accepts in `traceCallTypes`. */
export const TRACE_CALL_TYPES = [
  "CALL",
  "STATICCALL",
  "DELEGATECALL",
  "CALLCODE",
  "CREATE",
  "CREATE2",
  "SELFDESTRUCT",
] as const;

export const TRACE_STATUS_OPTIONS = [
  { value: "success", label: "Successful calls" },
  { value: "reverted", label: "Reverted calls" },
  { value: "any", label: "Any outcome" },
] as const;

/**
 * Parse a stored `traceCallTypes` into a list.
 *
 * The editor persists every config value as a string, so a multi-select
 * arrives as a JSON array string. An array is returned unchanged. Anything
 * unparseable is returned as-is so the tracker refuses it with a log line,
 * rather than being silently dropped here and widening the filter to every
 * frame type.
 */
export function parseTraceCallTypes(raw: unknown): unknown {
  if (Array.isArray(raw) || typeof raw !== "string") {
    return raw;
  }
  if (raw.trim() === "") {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : raw;
  } catch {
    return raw;
  }
}

/** Normalize a Trace trigger node's config in place for the event tracker. */
export function normalizeTraceTriggerConfig(
  config: Record<string, unknown>
): void {
  if (config.traceCallTypes !== undefined) {
    config.traceCallTypes = parseTraceCallTypes(config.traceCallTypes);
  }
}
