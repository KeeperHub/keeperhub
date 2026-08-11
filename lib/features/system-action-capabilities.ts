// Egress classification for built-in / system actions.
//
// System actions are not plugins, so they carry no `egress` field. This map is
// their source of truth. It is typed `Record<SystemActionType, EgressTier>`,
// and the executor's SYSTEM_ACTIONS dispatch table is `satisfies
// Record<SystemActionType, StepImporter>` - both keyed off the shared
// SYSTEM_ACTION_TYPES union - so a new system action is a compile error until it
// is both dispatched and classified here.
//
// Light imports only (a type and a const) - safe for client, server, edge, and
// the validator; does not pull in the executor.

import {
  SYSTEM_ACTION_TYPES,
  type SystemActionType,
} from "@/lib/workflow/executor/system-action-types";
import type { EgressTier } from "@/plugins/registry";

export const SYSTEM_ACTION_EGRESS: Record<SystemActionType, EgressTier> = {
  // The user supplies the connection (host) the runner queries.
  "Database Query": "user-destination",
  // The user supplies the full request URL.
  "HTTP Request": "user-destination",
  // Control-flow actions: no outbound network request.
  Condition: "none",
  "For Each": "none",
  Collect: "none",
};

const SYSTEM_ACTION_TYPE_SET: ReadonlySet<string> = new Set(
  SYSTEM_ACTION_TYPES
);

export function getSystemActionEgress(
  actionType: string
): EgressTier | undefined {
  if (!SYSTEM_ACTION_TYPE_SET.has(actionType)) {
    return undefined;
  }
  return SYSTEM_ACTION_EGRESS[actionType as SystemActionType];
}
