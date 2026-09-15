import { describe, expect, it } from "vitest";
import { buildConfigForActionTypeChange } from "@/lib/workflow/editor/action-type-transition";
import { evaluateShowWhen } from "@/lib/workflow/editor/show-when";
import { validateWorkflowActionConfigs } from "@/lib/workflow/validation/action-config";
import { findActionById, flattenConfigFields } from "@/plugins/registry";

const ACTION_TYPE = "data/encode";

const OPERATIONS = [
  "encode",
  "decode",
  "decimal-to-hex",
  "hex-to-decimal",
] as const;

function fields() {
  const action = findActionById(ACTION_TYPE);
  if (!action?.configFields) {
    throw new Error(`${ACTION_TYPE} has no config fields`);
  }
  return flattenConfigFields(action.configFields);
}

/**
 * The config the editor holds after the action is picked and the operation
 * changed: every default seeded, then the operation overridden. The seeded
 * defaults matter because a hidden field keeps its stored value.
 */
function editorConfig(
  operation: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    ...buildConfigForActionTypeChange(ACTION_TYPE, {}),
    operation,
    ...overrides,
  };
}

function visibleKeys(config: Record<string, unknown>): string[] {
  return fields()
    .filter((field) => evaluateShowWhen(field.showWhen, config))
    .map((field) => field.key);
}

function actionNode(config: Record<string, unknown>) {
  return {
    id: "node-1",
    type: "action",
    data: {
      label: "Encode / Decode",
      type: "action",
      config: { actionType: ACTION_TYPE, ...config },
    },
  };
}

describe("data/encode definition", () => {
  it("offers the four operations, text first", () => {
    const operation = fields().find((field) => field.key === "operation");

    expect(operation?.options?.map((option) => option.value)).toEqual([
      ...OPERATIONS,
    ]);
    expect(operation?.defaultValue).toBe("encode");
  });

  it("offers the integer widths as the number format", () => {
    const numberFormat = fields().find((field) => field.key === "numberFormat");

    expect(numberFormat?.options?.map((option) => option.value)).toEqual([
      "hex",
      "uint256",
      "uint128",
      "uint64",
    ]);
    expect(numberFormat?.defaultValue).toBe("hex");
  });

  it("seeds the text defaults when the action is picked", () => {
    const config = buildConfigForActionTypeChange(ACTION_TYPE, {});

    expect(config.operation).toBe("encode");
    expect(config.format).toBe("bytes32");
    expect(config.numberFormat).toBe("hex");
    expect(config.padding).toBe("right");
  });

  describe("field visibility", () => {
    it("shows format and padding for encode with a fixed-size format", () => {
      expect(visibleKeys(editorConfig("encode"))).toEqual([
        "operation",
        "value",
        "format",
        "padding",
      ]);
    });

    it("hides padding for encode when the format carries no padding", () => {
      for (const format of ["hex", "base64"]) {
        expect(visibleKeys(editorConfig("encode", { format }))).toEqual([
          "operation",
          "value",
          "format",
        ]);
      }
    });

    it("shows the same text fields for decode", () => {
      expect(visibleKeys(editorConfig("decode"))).toEqual([
        "operation",
        "value",
        "format",
        "padding",
      ]);
    });

    it("swaps format and padding for the number format on decimal-to-hex", () => {
      const config = editorConfig("decimal-to-hex");

      // The regression this guards: format is still stored as bytes32 from
      // the seeded defaults, which on its own would keep padding on screen.
      expect(config.format).toBe("bytes32");
      expect(visibleKeys(config)).toEqual([
        "operation",
        "value",
        "numberFormat",
      ]);
    });

    it("shows only the value for hex-to-decimal", () => {
      expect(visibleKeys(editorConfig("hex-to-decimal"))).toEqual([
        "operation",
        "value",
      ]);
    });
  });

  describe("save-time validation", () => {
    it.each(OPERATIONS)(
      "accepts the editor config for %s without a hidden-field error",
      (operation) => {
        const result = validateWorkflowActionConfigs([
          actionNode(editorConfig(operation, { value: "255" })),
        ]);

        expect(result).toEqual({ valid: true, issues: [] });
      }
    );

    it("does not require the number format: a node saved before the field existed can switch operation", () => {
      // Defaults are seeded only on an actionType change, so an older
      // data/encode node has no numberFormat key. The step falls back to hex.
      const result = validateWorkflowActionConfigs([
        actionNode({ operation: "decimal-to-hex", value: "255" }),
      ]);

      expect(result).toEqual({ valid: true, issues: [] });
    });

    it("still requires the text format for encode", () => {
      const result = validateWorkflowActionConfigs([
        actionNode({ operation: "encode", value: "SKY" }),
      ]);

      expect(result.issues).toEqual([
        expect.objectContaining({
          code: "MISSING_REQUIRED_FIELD",
          field: "format",
        }),
      ]);
    });

    it("needs nothing beyond the value for hex-to-decimal", () => {
      const result = validateWorkflowActionConfigs([
        actionNode({ operation: "hex-to-decimal", value: "0xff" }),
      ]);

      expect(result).toEqual({ valid: true, issues: [] });
    });

    it("still requires the value", () => {
      const result = validateWorkflowActionConfigs([
        actionNode(editorConfig("decimal-to-hex")),
      ]);

      expect(result.valid).toBe(false);
      expect(result.issues).toEqual([
        expect.objectContaining({
          path: "nodes[0].data.config.value",
        }),
      ]);
    });
  });
});
