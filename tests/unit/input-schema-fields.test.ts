import { describe, expect, it } from "vitest";
import { getInputSchemaFields } from "@/lib/workflow/editor/input-schema-fields";

describe("getInputSchemaFields", () => {
  it("returns an empty list when the schema is null", () => {
    expect(getInputSchemaFields(null)).toEqual([]);
  });

  it("returns an empty list when the schema is undefined", () => {
    expect(getInputSchemaFields(undefined)).toEqual([]);
  });

  it("returns an empty list when properties are missing", () => {
    expect(getInputSchemaFields({ type: "object" })).toEqual([]);
  });

  it("returns an empty list when properties is not an object", () => {
    expect(
      getInputSchemaFields({ type: "object", properties: "not-an-object" })
    ).toEqual([]);
  });

  it("emits each declared property as data.<name>", () => {
    const schema = {
      type: "object",
      properties: {
        address: { type: "string" },
        chainId: { type: "number" },
      },
      required: ["address"],
    };

    const fields = getInputSchemaFields(schema);

    expect(fields).toEqual([
      { field: "data.address", description: "Listed workflow input" },
      { field: "data.chainId", description: "Listed workflow input" },
    ]);
  });

  it("preserves the user-provided description", () => {
    const schema = {
      type: "object",
      properties: {
        address: {
          type: "string",
          description: "Wallet address to inspect",
        },
      },
    };

    expect(getInputSchemaFields(schema)).toEqual([
      { field: "data.address", description: "Wallet address to inspect" },
    ]);
  });

  it("falls back when description is not a non-empty string", () => {
    const schema = {
      type: "object",
      properties: {
        address: { type: "string", description: "" },
        chainId: { type: "number", description: 42 },
      },
    };

    expect(getInputSchemaFields(schema)).toEqual([
      { field: "data.address", description: "Listed workflow input" },
      { field: "data.chainId", description: "Listed workflow input" },
    ]);
  });

  it("ignores non-object property entries without crashing", () => {
    const schema = {
      type: "object",
      properties: {
        ok: { type: "string", description: "fine" },
        broken: null,
      },
    };

    expect(getInputSchemaFields(schema)).toEqual([
      { field: "data.ok", description: "fine" },
      { field: "data.broken", description: "Listed workflow input" },
    ]);
  });
});
