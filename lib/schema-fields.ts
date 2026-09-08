/**
 * Schema definitions edited by the SchemaBuilder are persisted as JSON strings
 * in node config, so a stored value can be any JSON shape by the time it is
 * read back. These helpers narrow it to the array the builder renders.
 */

export type SchemaField = {
  id?: string;
  name: string;
  type: "string" | "number" | "boolean" | "array" | "object";
  itemType?: "string" | "number" | "boolean" | "object";
  fields?: SchemaField[];
  description?: string;
  required?: boolean;
};

export function toSchemaFields(value: unknown): SchemaField[] {
  return Array.isArray(value) ? (value as SchemaField[]) : [];
}

export function parseSchemaFields(raw: unknown): SchemaField[] {
  if (typeof raw !== "string") {
    return toSchemaFields(raw);
  }

  try {
    return toSchemaFields(JSON.parse(raw));
  } catch {
    return [];
  }
}
