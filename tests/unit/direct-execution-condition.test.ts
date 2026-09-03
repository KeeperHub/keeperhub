import { describe, expect, it } from "vitest";
import { evaluateCondition } from "@/app/api/execute/_lib/condition";

describe("direct-execution condition evaluation", () => {
  it.each([
    ["eq", "100", true],
    ["neq", "100", false],
    ["gt", "99", true],
    ["lt", "101", true],
    ["gte", "100", true],
    ["lte", "100", true],
  ] as const)("compares integer strings with %s", (operator, target, met) => {
    expect(evaluateCondition("100", { operator, value: target })).toEqual({
      met,
      observedValue: "100",
      targetValue: target,
      operator,
    });
  });

  it("unwraps the named scalar shape returned by readContractCore", () => {
    expect(
      evaluateCondition({ balance: "100" }, { operator: "gt", value: "50" })
    ).toMatchObject({ met: true, observedValue: "100" });
  });

  it.each([
    ["eq", true],
    ["neq", false],
  ] as const)("compares hexadecimal address values case-insensitively with %s", (operator, met) => {
    expect(
      evaluateCondition("0xAbCdEf0123456789AbCdEf0123456789AbCdEf01", {
        operator,
        value: "0xabcdef0123456789abcdef0123456789abcdef01",
      })
    ).toMatchObject({ met });
  });

  it.each([
    ["eq", true],
    ["neq", false],
  ] as const)("compares fixed-bytes values case-insensitively with %s", (operator, met) => {
    expect(
      evaluateCondition(
        "0xAbCdEf0123456789AbCdEf0123456789AbCdEf0123456789AbCdEf0123456789",
        {
          operator,
          value:
            "0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
        }
      )
    ).toMatchObject({ met });
  });

  it.each([
    ["a multi-output object", { roundId: "1", answer: "2" }],
    ["an array output", ["100"]],
    ["a tuple output", { quote: { answer: "100" } }],
    ["a non-numeric scalar", "not-a-number"],
  ])("rejects %s instead of falling back to string inequality", (_label, value) => {
    expect(
      evaluateCondition(value, { operator: "neq", value: "0" })
    ).toBeNull();
  });

  it("rejects a non-numeric target instead of falling back to string inequality", () => {
    expect(
      evaluateCondition("100", { operator: "neq", value: "not-a-number" })
    ).toBeNull();
  });

  it("rejects JavaScript numbers because readContractCore returns strings", () => {
    expect(evaluateCondition(100, { operator: "eq", value: "100" })).toBeNull();
  });
});
