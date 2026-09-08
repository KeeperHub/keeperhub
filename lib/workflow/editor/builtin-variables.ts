/**
 * Built-in System Variables
 * Provides runtime-evaluated variables available in all workflow template fields.
 * These are injected as a pseudo-node with a reserved ID into the outputs map.
 *
 * NOTE: This module has zero dependencies so it can be safely imported in both
 * server-side code and "use client" components.
 */

/** Reserved node ID for built-in system variables. Must not collide with user node IDs. */
export const BUILTIN_NODE_ID = "__system";

/** Display label shown in autocomplete UI and template syntax */
export const BUILTIN_NODE_LABEL = "System";

/** Static field definitions for autocomplete, badge validation, and MCP schemas */
export const BUILTIN_VARIABLE_FIELDS = [
  {
    field: "unixTimestamp",
    description:
      "Current time as Unix timestamp in seconds (Solidity-compatible)",
  },
  {
    field: "unixTimestampMs",
    description: "Current time as Unix timestamp in milliseconds",
  },
  {
    field: "isoTimestamp",
    description: "Current time as ISO 8601 UTC string",
  },
] as const;

/**
 * Returns current built-in variable values.
 * MUST be called at evaluation time (not cached) so timestamps are fresh.
 */
export function getBuiltinVariables(): Record<string, unknown> {
  const now = Date.now();
  return {
    unixTimestamp: Math.floor(now / 1000),
    unixTimestampMs: now,
    isoTimestamp: new Date(now).toISOString(),
  };
}
