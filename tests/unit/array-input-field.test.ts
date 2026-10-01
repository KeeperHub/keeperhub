import { describe, expect, it } from "vitest";
import { parseArrayValue } from "@/components/workflow/config/array-input-field";

describe("parseArrayValue", () => {
  it("preserves legacy comma-separated scalar-array values", () => {
    let id = 0;
    expect(
      parseArrayValue(
        "0xpool1, 0xpool2",
        () => {
          id += 1;
          return id;
        },
        undefined,
        "address"
      )
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
      parseArrayValue(
        "{{a}}, {{b}}",
        () => {
          id += 1;
          return id;
        },
        undefined,
        "uint256"
      )
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

  it("does not split or migrate commas that are valid string data", () => {
    expect(
      parseArrayValue("Hello, world", () => 1, undefined, "string")
    ).toEqual([{ id: 1, value: "Hello, world" }]);
  });

  it("renders non-string scalar-array elements as their execution text", () => {
    expect(
      parseArrayValue(
        [135_184, true, { amount: "1" }, [1, 2]],
        (() => {
          let id = 0;
          return () => {
            id += 1;
            return id;
          };
        })(),
        undefined,
        "uint256"
      )
    ).toEqual([
      { id: 1, value: "135184" },
      { id: 2, value: "true" },
      { id: 3, value: '{"amount":"1"}' },
      { id: 4, value: "[1,2]" },
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
