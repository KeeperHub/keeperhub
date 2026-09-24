/**
 * Trace trigger config shared by the editor and the events worker endpoint.
 *
 * Reconciles the shape the editor stores with the shape the tracker expects,
 * and holds the checks the events endpoint applies before handing a Trace
 * workflow over. Nothing validates trigger nodes on save, so these are the
 * app side's only checks. The tracker's workflow mapper re-validates the same
 * fields at map time (#2469) and skips a workflow it cannot read, but that
 * refusal is a log line, so a bad filter is still refused here first.
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

/**
 * Frame types the tracker accepts in `traceCallTypes`.
 *
 * Compared case-insensitively on both sides: the tracker upper-cases each
 * entry before testing membership, so refusing a lowercase one here would
 * drop a workflow it would have accepted, and an MCP author writing
 * `["call"]` would see an enabled workflow that never fires.
 */
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
 * unparseable is returned as-is rather than dropped, which would widen the
 * filter to every frame type; isValidTraceCallTypes is what refuses it.
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

/** A 20-byte hex address, as the Watched Contract field has to hold. */
export const TRACE_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/**
 * Whether a stored `contractAddress` is usable.
 *
 * Unlike every other Trace filter, this one is required. Each optional filter
 * matches everything when it is absent, so a Trace trigger saved with a
 * network and nothing else would fire on every call frame on the chain: the
 * fires-on-everything direction, with a firing-rate and billing cost the
 * never-fires direction does not have. The field's `required` flag only draws
 * an asterisk and blocks no save, so the check has to live here.
 *
 * A template is refused too: a trigger runs before any node, so there is
 * nothing for `{{Node.address}}` to resolve against.
 */
export function isValidTraceContractAddress(raw: unknown): boolean {
  return typeof raw === "string" && TRACE_ADDRESS_PATTERN.test(raw.trim());
}

export type TraceConfigCheck =
  | { ok: true }
  | { ok: false; reason: "contract-address" | "call-types" | "selector" };

/**
 * Validate a Trace trigger node's config and, only if it passes, normalize it
 * in place into the shape the event tracker compares.
 *
 * One function rather than a validator and a normalizer the caller has to run
 * in the right order: normalizing an unvalidated config would forward
 * `traceCallTypes: "garbage"` verbatim to a matcher that calls `.some` on it.
 * On a failure the config is left untouched.
 */
export function prepareTraceTriggerConfig(
  config: Record<string, unknown>
): TraceConfigCheck {
  if (!isValidTraceContractAddress(config.contractAddress)) {
    return { ok: false, reason: "contract-address" };
  }
  if (!isValidTraceCallTypes(config.traceCallTypes)) {
    return { ok: false, reason: "call-types" };
  }
  if (!isValidTraceSelector(config.traceSelector)) {
    return { ok: false, reason: "selector" };
  }
  normalizeTraceTriggerConfig(config);
  return { ok: true };
}

/** Normalize an already validated Trace trigger config in place. */
function normalizeTraceTriggerConfig(config: Record<string, unknown>): void {
  if (typeof config.contractAddress === "string") {
    config.contractAddress = config.contractAddress.trim();
  }
  // The panel shows "Successful calls" for a config that never set the
  // outcome. Defaulting it here, on the way to the tracker, keeps what the
  // panel shows and what registers in step without the panel having to
  // write the value on first render and dirty the canvas.
  if (config.traceStatus === undefined || config.traceStatus === "") {
    config.traceStatus = "success";
  }
  if (config.traceCallTypes !== undefined) {
    config.traceCallTypes = parseTraceCallTypes(config.traceCallTypes);
  }
  // Validated trimmed, so it has to leave trimmed: the matcher compares the
  // selector against the frame's first four bytes as-is, and a value pasted
  // with a trailing space would register and never match.
  if (typeof config.traceSelector === "string") {
    config.traceSelector = config.traceSelector.trim();
  }
  // Same reasoning for the call types, which are validated case-insensitively:
  // the shape that leaves here is the upper-case one the tracker compares.
  if (Array.isArray(config.traceCallTypes)) {
    config.traceCallTypes = config.traceCallTypes.map((entry) =>
      typeof entry === "string" ? entry.trim().toUpperCase() : entry
    );
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
      (TRACE_CALL_TYPES as readonly string[]).includes(
        entry.trim().toUpperCase()
      )
  );
}
