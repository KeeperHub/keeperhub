/**
 * Trace trigger config shared by the editor and the events worker endpoint.
 *
 * The event tracker validates every field again at map time
 * (keeperhub-events/event-tracker/src/listener/workflow-mapper.ts) and refuses
 * a workflow whose filter it cannot read. This module only reconciles the
 * shape the editor stores with the shape the tracker expects.
 */

/**
 * Networks a Trace trigger may be configured for.
 *
 * A cold-start floor, not a capability report: these are the chains whose
 * RPC endpoints are known to serve the block call traces this trigger reads.
 * Offering the trigger on a chain that does not serve them produces a
 * trigger that never fires and reports nothing.
 *
 * The tracker learns what a connection supports at runtime, relearns it on
 * reconnect and runs a single replica, so a list derived from that alone is
 * empty after every restart until a drain runs. This seed is what that
 * report would union with once it exists.
 */
export const TRACE_SEED_CHAIN_IDS = [
  "9745", // Plasma
  "9746", // Plasma Testnet
  "4217", // Tempo
  "42431", // Tempo Testnet
] as const;

/** A raw 4-byte function selector, as typed into the Trace trigger. */
export const TRACE_SELECTOR_PATTERN = /^0x[0-9a-fA-F]{8}$/;

/**
 * Whether a stored `traceSelector` is usable.
 *
 * Empty means "any function" and is valid. Anything else has to be a
 * 4-byte selector: the matcher compares it against the first four bytes of
 * a call frame's input, so `pause()` or a truncated `0x845` matches nothing
 * and produces a trigger that registers, never fires, and reports no error
 * anywhere. Checked in the panel and again on the way to the tracker, since
 * trigger nodes are not covered by the action-config validation that runs
 * on save.
 */
export function isValidTraceSelector(raw: unknown): boolean {
  if (raw === undefined || raw === null || raw === "") {
    return true;
  }
  return typeof raw === "string" && TRACE_SELECTOR_PATTERN.test(raw.trim());
}

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

/**
 * Whether a stored `traceCallTypes` is a shape the tracker can read.
 *
 * An unparseable value used to be passed through on the theory that the
 * tracker would refuse it and log; no such refusal exists, and a bare string
 * reaching the matcher has `.some` called on it inside the per-block drain.
 * Meanwhile the editor collapses a non-array to an empty list, so the panel
 * shows nothing checked and the first toggle silently overwrites it. Neither
 * half was doing what the comment claimed, so the value is checked instead.
 */
export function isValidTraceCallTypes(raw: unknown): boolean {
  if (raw === undefined || raw === null || raw === "") {
    return true;
  }
  const parsed = parseTraceCallTypes(raw);
  if (!Array.isArray(parsed)) {
    return false;
  }
  return parsed.every(
    (entry) =>
      typeof entry === "string" &&
      (TRACE_CALL_TYPES as readonly string[]).includes(entry)
  );
}
