import { describe, expect, it } from "vitest";

import { parseSchemaFields, toSchemaFields } from "@/lib/schema-fields";

describe("parseSchemaFields", () => {
  it("parses a stored array of fields", () => {
    const raw = JSON.stringify([
      { name: "amount", type: "number" },
      { name: "token", type: "string" },
    ]);

    expect(parseSchemaFields(raw)).toEqual([
      { name: "amount", type: "number" },
      { name: "token", type: "string" },
    ]);
  });

  it("returns an empty array when the stored JSON is an object", () => {
    expect(parseSchemaFields('{"amount":"number"}')).toEqual([]);
  });

  it("returns an empty array for other non-array JSON values", () => {
    expect(parseSchemaFields('"amount"')).toEqual([]);
    expect(parseSchemaFields("42")).toEqual([]);
    expect(parseSchemaFields("null")).toEqual([]);
    expect(parseSchemaFields("true")).toEqual([]);
  });

  it("returns an empty array for malformed JSON", () => {
    expect(parseSchemaFields("{not json")).toEqual([]);
  });

  it("returns an empty array for empty and missing values", () => {
    expect(parseSchemaFields("")).toEqual([]);
    expect(parseSchemaFields(undefined)).toEqual([]);
    expect(parseSchemaFields(null)).toEqual([]);
  });

  it("accepts an already-parsed array without re-parsing", () => {
    const fields = [{ name: "amount", type: "number" }];

    expect(parseSchemaFields(fields)).toEqual(fields);
  });
});

describe("toSchemaFields", () => {
  it("passes arrays through and replaces everything else with an empty array", () => {
    const nested = [{ name: "inner", type: "string" }];

    expect(toSchemaFields(nested)).toBe(nested);
    expect(toSchemaFields({ inner: "string" })).toEqual([]);
    expect(toSchemaFields(undefined)).toEqual([]);
  });
});
