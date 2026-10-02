/**
 * Text for the State Set value editor. The editor stores strings, but a node
 * authored through MCP can hold any JSON value, and the code editor calls
 * string methods on what it is given. Objects and arrays are shown as JSON
 * and scalars as their literal text, which the step's coercion reads back as
 * the same value when the node is saved from the editor.
 */
export function stateValueToEditorText(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "object") {
    return JSON.stringify(value, null, 2);
  }
  return String(value);
}

/** Output fields the builder's @ menu offers for a State Get node. */
export const STATE_GET_OUTPUT_FIELDS = [
  { field: "exists", description: "Whether the key has a live value" },
  { field: "value", description: "Stored value (null when missing)" },
  { field: "version", description: "Key version (0 when missing)" },
];

/** Output fields the builder's @ menu offers for a State Set node. */
export const STATE_SET_OUTPUT_FIELDS = [
  { field: "created", description: "Whether this write created the key" },
  { field: "version", description: "Key version after this write" },
];
