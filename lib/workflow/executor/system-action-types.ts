// Single source of truth for the built-in (non-plugin) action types the
// executor dispatches. Both the executor's SYSTEM_ACTIONS dispatch table
// (lib/workflow/executor/executor.workflow.ts) and the egress classification
// map (lib/features/system-action-capabilities.ts) are keyed off this union via
// `satisfies` / `Record<SystemActionType, ...>`, so adding a system action is a
// compile error until it is BOTH dispatched and classified. No imports - safe to
// load anywhere (client, server, edge, tests).

export const SYSTEM_ACTION_TYPES = [
  "Database Query",
  "HTTP Request",
  "Condition",
  "For Each",
  "Collect",
] as const;

export type SystemActionType = (typeof SYSTEM_ACTION_TYPES)[number];
