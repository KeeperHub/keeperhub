import { describe, expect, it } from "vitest";
import {
  buildManualRunSample,
  hasManualRunInputs,
  validateManualRunInput,
} from "./manual-run-input";

const schema = {
  type: "object",
  properties: {
    sender: { type: "string" },
    value: { type: "string", default: "0" },
    dryRun: { type: "boolean" },
  },
  required: ["sender", "value"],
};

describe("manual run input", () => {
  it("detects workflows with declared inputs", () => {
    expect(hasManualRunInputs(schema)).toBe(true);
    expect(hasManualRunInputs({ type: "object", properties: {} })).toBe(false);
  });

  it("builds a schema-shaped starting payload", () => {
    expect(buildManualRunSample(schema)).toEqual({
      sender: "",
      value: "0",
      dryRun: false,
    });
  });

  it("reports every missing required input", () => {
    expect(validateManualRunInput(schema, {})).toEqual([
      'Required input "sender" is missing.',
      'Required input "value" is missing.',
    ]);
  });
});
