import { describe, expect, it } from "vitest";
import { stateValueToEditorText } from "@/lib/workflow/nodes/workflow-state/utils";

describe("stateValueToEditorText", () => {
  it("passes strings through", () => {
    expect(stateValueToEditorText("{{@get:State Get.value}}")).toBe(
      "{{@get:State Get.value}}"
    );
  });

  it("shows MCP-authored scalars as their literal text, including falsy ones", () => {
    expect(stateValueToEditorText(123)).toBe("123");
    expect(stateValueToEditorText(0)).toBe("0");
    expect(stateValueToEditorText(false)).toBe("false");
  });

  it("shows objects and arrays as JSON", () => {
    expect(JSON.parse(stateValueToEditorText({ seen: ["0xa"] }))).toEqual({
      seen: ["0xa"],
    });
    expect(JSON.parse(stateValueToEditorText([1, 2]))).toEqual([1, 2]);
  });

  it("shows a missing value as empty", () => {
    expect(stateValueToEditorText(undefined)).toBe("");
    expect(stateValueToEditorText(null)).toBe("");
  });
});
