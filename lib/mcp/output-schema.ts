// Derives the optional `outputSchema` surfaced by list_action_schemas.
// Pure (no DB / network) so it can be unit-tested without the route harness.

import type { PluginAction } from "@/plugins/registry";

/**
 * Build a JSON Schema for an action's output.
 *
 * - When the action declares `outputSchema` explicitly, it is returned as-is
 *   (for actions whose output is richer than a flat key/description map).
 * - Otherwise it is synthesized from `outputFields`: each field becomes a
 *   property carrying its description. Types are left unconstrained because
 *   outputFields do not record them.
 * - Returns null when the action declares no outputs, so the caller can omit
 *   the key entirely rather than emit an empty schema.
 */
export function synthesizeOutputSchema(
  action: PluginAction
): Record<string, unknown> | null {
  if (action.outputSchema) {
    return action.outputSchema;
  }
  if (!action.outputFields || action.outputFields.length === 0) {
    return null;
  }
  const properties: Record<string, { description: string }> = {};
  for (const output of action.outputFields) {
    properties[output.field] = { description: output.description };
  }
  return { type: "object", properties };
}
