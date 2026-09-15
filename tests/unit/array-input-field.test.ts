import { describe, expect, it } from "vitest";
import { parseArrayValue } from "@/components/workflow/config/array-input-field";

describe("parseArrayValue", () => {
  it("preserves legacy comma-separated scalar-array values", () => {
    let id = 0;
    expect(
      parseArrayValue("0xpool1, 0xpool2", () => {
        id += 1;
        return id;
      })
    ).toEqual([
      { id: 1, value: "0xpool1" },
      { id: 2, value: "0xpool2" },
    ]);
  });
});
