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

  it("renders a whole-field template as one array row", () => {
    let id = 0;
    expect(
      parseArrayValue("{{previous.items}}", () => {
        id += 1;
        return id;
      })
    ).toEqual([{ id: 1, value: "{{previous.items}}" }]);
  });

  it("does not greedily treat multiple templates as one whole-field template", () => {
    let id = 0;
    expect(
      parseArrayValue("{{a}}, {{b}}", () => {
        id += 1;
        return id;
      })
    ).toEqual([
      { id: 1, value: "{{a}}" },
      { id: 2, value: "{{b}}" },
    ]);
  });

  it("keeps JSON numeric scalars as their exact raw legacy value", () => {
    expect(parseArrayValue("1000000000000000000000", () => 1)).toEqual([
      { id: 1, value: "1000000000000000000000" },
    ]);
    expect(parseArrayValue("12345678901234567890", () => 2)).toEqual([
      { id: 2, value: "12345678901234567890" },
    ]);
  });

  it("keeps a JSON object as raw text for scalar arrays", () => {
    expect(parseArrayValue('{"amount":"1"}', () => 1)).toEqual([
      { id: 1, value: '{"amount":"1"}' },
    ]);
  });

  it("keeps a parsed JSON object for tuple arrays", () => {
    expect(
      parseArrayValue('{"amount":"1"}', () => 1, [
        { name: "amount", type: "uint256" },
      ])
    ).toEqual([{ id: 1, value: { amount: "1" } }]);
  });

  it("keeps an encoded empty array empty", () => {
    expect(parseArrayValue("[]", () => 1)).toEqual([]);
  });
});
