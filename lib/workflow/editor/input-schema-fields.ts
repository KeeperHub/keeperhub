/**
 * Listing inputSchema field extraction.
 *
 * Listed (agent-callable) workflows declare an inputSchema -- a JSON-Schema-like
 * shape describing the parameters callers must provide. At runtime the executor
 * merges the request body into the trigger output's `data` (see
 * lib/workflow/executor/executor.workflow.ts), so each declared property is
 * accessible to downstream nodes as `<TriggerName>.data.<fieldName>`.
 *
 * Without this helper, autocomplete only surfaces those paths after the
 * workflow has been called by an agent (so a runtime execution log captured
 * them). This helper exposes them statically based on the schema declaration.
 */

import type { FieldEntry } from "@/lib/workflow/editor/template-helpers";

const DESCRIPTION_FALLBACK = "Listed workflow input";

export function getInputSchemaFields(
  inputSchema: Record<string, unknown> | null | undefined
): FieldEntry[] {
  if (!inputSchema || typeof inputSchema !== "object") {
    return [];
  }
  const properties = (inputSchema as Record<string, unknown>).properties;
  if (!properties || typeof properties !== "object") {
    return [];
  }

  const result: FieldEntry[] = [];
  for (const [name, rawProp] of Object.entries(
    properties as Record<string, unknown>
  )) {
    const prop = (rawProp ?? {}) as Record<string, unknown>;
    const description =
      typeof prop.description === "string" && prop.description
        ? prop.description
        : DESCRIPTION_FALLBACK;
    result.push({
      field: `data.${name}`,
      description,
    });
  }
  return result;
}
