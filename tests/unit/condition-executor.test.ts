import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { evaluateConditionExpression } from "@/lib/workflow/executor/executor.workflow";
import { resolveConditionExpression } from "@/lib/workflow/nodes/condition/resolver";

const NO_EXPRESSION_REGEX = /no expression configured/;
const NO_OUTPUT_FOUND_RE = /no output was found/;
const FAILED_TO_EVALUATE_RE = /Failed to evaluate condition expression/;

/**
 * Tests for KEEP-1520: Condition node losing expression at runtime
 *
 * Verifies that the resolver correctly derives expressions from conditionConfig
 * and that the executor can evaluate conditions from either source.
 */
describe("condition executor with conditionConfig", () => {
  describe("resolveConditionExpression integration with executor", () => {
    it("should resolve and evaluate from conditionConfig only (no condition string)", () => {
      const config: Record<string, unknown> = {
        conditionConfig: {
          group: {
            id: "g1",
            logic: "AND",
            rules: [
              {
                id: "r1",
                leftOperand: "{{@node1:Label.value}}",
                operator: ">",
                rightOperand: "100",
              },
            ],
          },
        },
      };

      const expression = resolveConditionExpression(config);
      expect(expression).toBe("{{@node1:Label.value}} > 100");

      const outputs = {
        node1: { label: "Label", data: { value: 150 } },
      };

      const result = evaluateConditionExpression(expression, outputs);
      expect(result.result).toBe(true);
    });

    it("should resolve and evaluate from condition string when conditionConfig is absent", () => {
      const config: Record<string, unknown> = {
        condition: "{{@node1:Label.count}} === 5",
      };

      const expression = resolveConditionExpression(config);
      expect(expression).toBe("{{@node1:Label.count}} === 5");

      const outputs = {
        node1: { label: "Label", data: { count: 5 } },
      };

      const result = evaluateConditionExpression(expression, outputs);
      expect(result.result).toBe(true);
    });

    it("should prioritize conditionConfig over stale condition string", () => {
      const config: Record<string, unknown> = {
        condition: "stale !== expression",
        conditionConfig: {
          group: {
            id: "g1",
            logic: "AND",
            rules: [
              {
                id: "r1",
                leftOperand: "{{@node1:API.status}}",
                operator: "===",
                rightOperand: "200",
              },
            ],
          },
        },
      };

      const expression = resolveConditionExpression(config);
      expect(expression).toBe("{{@node1:API.status}} === 200");

      const outputs = {
        node1: { label: "API", data: { status: 200 } },
      };

      const result = evaluateConditionExpression(expression, outputs);
      expect(result.result).toBe(true);
    });

    it("should return undefined when neither config source exists", () => {
      const config: Record<string, unknown> = {};
      const expression = resolveConditionExpression(config);
      expect(expression).toBeUndefined();
    });

    it("should throw when executor receives undefined expression", () => {
      expect(() => evaluateConditionExpression(undefined, {})).toThrow(
        NO_EXPRESSION_REGEX
      );
    });

    it("should handle conditionConfig with multiple visual rules", () => {
      const config: Record<string, unknown> = {
        conditionConfig: {
          group: {
            id: "g1",
            logic: "AND",
            rules: [
              {
                id: "r1",
                leftOperand: "{{@node1:Label.a}}",
                operator: ">",
                rightOperand: "0",
              },
              {
                id: "r2",
                leftOperand: "{{@node1:Label.b}}",
                operator: "<",
                rightOperand: "100",
              },
            ],
          },
        },
      };

      const expression = resolveConditionExpression(config);
      expect(expression).toBe(
        "{{@node1:Label.a}} > 0 && {{@node1:Label.b}} < 100"
      );

      const outputs = {
        node1: { label: "Label", data: { a: 5, b: 50 } },
      };

      const result = evaluateConditionExpression(expression, outputs);
      expect(result.result).toBe(true);
    });

    it("should handle conditionConfig with OR logic", () => {
      const config: Record<string, unknown> = {
        conditionConfig: {
          group: {
            id: "g1",
            logic: "OR",
            rules: [
              {
                id: "r1",
                leftOperand: "{{@node1:Label.x}}",
                operator: "===",
                rightOperand: "1",
              },
              {
                id: "r2",
                leftOperand: "{{@node1:Label.x}}",
                operator: "===",
                rightOperand: "2",
              },
            ],
          },
        },
      };

      const expression = resolveConditionExpression(config);
      expect(expression).toContain("||");

      const outputs = {
        node1: { label: "Label", data: { x: 2 } },
      };

      const result = evaluateConditionExpression(expression, outputs);
      expect(result.result).toBe(true);
    });
  });
});

/**
 * Edge case tests for condition evaluation
 *
 * Covers tricky scenarios like BigInt-like string values, type coercion pitfalls,
 * and boundary conditions that could produce wrong evaluation results.
 */
describe("condition evaluation edge cases", () => {
  describe("string values representing large numbers (BigInt-like)", () => {
    it("should correctly compare a string-number value with > operator", () => {
      const expression = "{{@node1:Contract.balance}} > 1000000000000000000";
      const outputs = {
        node1: {
          label: "Contract",
          data: { balance: "2000000000000000000" },
        },
      };

      const result = evaluateConditionExpression(expression, outputs);
      // BigInt mode: BigInt("2000000000000000000") > BigInt("1000000000000000000") -> true
      expect(result.result).toBe(true);
    });

    it("should not match BigInt value against quoted string literal", () => {
      // BigInt mode triggers because balance exceeds MAX_SAFE_INTEGER.
      // Left side (context var) becomes BigInt, but the right side is a quoted
      // string literal which stays as a string. BigInt !== string -> false.
      // For numeric comparisons, users should use unquoted literals.
      const expression =
        '{{@node1:Contract.balance}} === "2000000000000000000"';
      const outputs = {
        node1: {
          label: "Contract",
          data: { balance: "2000000000000000000" },
        },
      };

      const result = evaluateConditionExpression(expression, outputs);
      expect(result.result).toBe(false);
    });

    it("should correctly compare large numeric string with number literal using BigInt mode", () => {
      // BigInt mode activates: both sides become BigInt for exact comparison
      const expression = "{{@node1:Contract.balance}} === 1000000000000000001";
      const outputs = {
        node1: {
          label: "Contract",
          data: { balance: "1000000000000000001" },
        },
      };

      const result = evaluateConditionExpression(expression, outputs);
      // BigInt("1000000000000000001") === BigInt("1000000000000000001") -> true
      expect(result.result).toBe(true);
    });

    it("should handle zero balance string correctly", () => {
      const expression = "{{@node1:Contract.balance}} === '0'";
      const outputs = {
        node1: { label: "Contract", data: { balance: "0" } },
      };

      const result = evaluateConditionExpression(expression, outputs);
      expect(result.result).toBe(true);
    });
  });

  describe("type coercion pitfalls with == vs ===", () => {
    it("should differentiate string '0' from number 0 with strict equality", () => {
      const expression = "{{@node1:API.value}} === 0";
      const outputs = {
        node1: { label: "API", data: { value: "0" } },
      };

      const result = evaluateConditionExpression(expression, outputs);
      // "0" === 0 is false (different types)
      expect(result.result).toBe(false);
    });

    it("should equate string '0' and number 0 with loose equality", () => {
      const expression = "{{@node1:API.value}} == 0";
      const outputs = {
        node1: { label: "API", data: { value: "0" } },
      };

      const result = evaluateConditionExpression(expression, outputs);
      // "0" == 0 is true (JS type coercion)
      expect(result.result).toBe(true);
    });

    it("should handle string 'true' vs boolean true with strict equality", () => {
      const expression = "{{@node1:API.flag}} === true";
      const outputs = {
        node1: { label: "API", data: { flag: "true" } },
      };

      const result = evaluateConditionExpression(expression, outputs);
      // "true" === true is false
      expect(result.result).toBe(false);
    });

    it("should handle string 'false' as truthy with existence check", () => {
      // The string "false" is truthy in JS
      const expression = "{{@node1:API.flag}} !== ''";
      const outputs = {
        node1: { label: "API", data: { flag: "false" } },
      };

      const result = evaluateConditionExpression(expression, outputs);
      expect(result.result).toBe(true);
    });

    it("should handle null value with strict equality", () => {
      const expression = "{{@node1:API.value}} === null";
      const outputs = {
        node1: { label: "API", data: { value: null } },
      };

      const result = evaluateConditionExpression(expression, outputs);
      expect(result.result).toBe(true);
    });
  });

  describe("numeric edge cases", () => {
    it("should handle negative numbers correctly", () => {
      const expression = "{{@node1:API.temp}} < 0";
      const outputs = {
        node1: { label: "API", data: { temp: -5 } },
      };

      const result = evaluateConditionExpression(expression, outputs);
      expect(result.result).toBe(true);
    });

    it("should handle floating point comparison", () => {
      const expression = "{{@node1:API.price}} > 9.99";
      const outputs = {
        node1: { label: "API", data: { price: 10.0 } },
      };

      const result = evaluateConditionExpression(expression, outputs);
      expect(result.result).toBe(true);
    });

    it("should handle NaN correctly - NaN is not equal to anything", () => {
      const expression = "{{@node1:API.value}} === {{@node1:API.value}}";
      const outputs = {
        node1: { label: "API", data: { value: Number.NaN } },
      };

      const result = evaluateConditionExpression(expression, outputs);
      // NaN === NaN is false
      expect(result.result).toBe(false);
    });

    it("should handle Infinity comparison", () => {
      const expression = "{{@node1:API.value}} > 999999";
      const outputs = {
        node1: { label: "API", data: { value: Number.POSITIVE_INFINITY } },
      };

      const result = evaluateConditionExpression(expression, outputs);
      expect(result.result).toBe(true);
    });
  });

  describe("string operator edge cases via visual builder", () => {
    it("should handle 'contains' with empty substring", () => {
      const config: Record<string, unknown> = {
        conditionConfig: {
          group: {
            id: "g1",
            logic: "AND",
            rules: [
              {
                id: "r1",
                leftOperand: "{{@node1:API.text}}",
                operator: "contains",
                rightOperand: "",
              },
            ],
          },
        },
      };

      const expression = resolveConditionExpression(config);
      expect(expression).toBeDefined();

      const outputs = {
        node1: { label: "API", data: { text: "hello" } },
      };

      // String.includes("") always returns true
      const result = evaluateConditionExpression(expression, outputs);
      expect(result.result).toBe(true);
    });

    it("should handle 'isEmpty' check on empty string", () => {
      const config: Record<string, unknown> = {
        conditionConfig: {
          group: {
            id: "g1",
            logic: "AND",
            rules: [
              {
                id: "r1",
                leftOperand: "{{@node1:API.text}}",
                operator: "isEmpty",
                rightOperand: "",
              },
            ],
          },
        },
      };

      const expression = resolveConditionExpression(config);
      expect(expression).toBeDefined();

      const outputs = {
        node1: { label: "API", data: { text: "" } },
      };

      const result = evaluateConditionExpression(expression, outputs);
      expect(result.result).toBe(true);
    });

    it("should handle 'isEmpty' check on non-empty string", () => {
      const config: Record<string, unknown> = {
        conditionConfig: {
          group: {
            id: "g1",
            logic: "AND",
            rules: [
              {
                id: "r1",
                leftOperand: "{{@node1:API.text}}",
                operator: "isEmpty",
                rightOperand: "",
              },
            ],
          },
        },
      };

      const expression = resolveConditionExpression(config);

      const outputs = {
        node1: { label: "API", data: { text: "not empty" } },
      };

      const result = evaluateConditionExpression(expression, outputs);
      expect(result.result).toBe(false);
    });

    it("should handle 'exists' check on zero (falsy but exists)", () => {
      const config: Record<string, unknown> = {
        conditionConfig: {
          group: {
            id: "g1",
            logic: "AND",
            rules: [
              {
                id: "r1",
                leftOperand: "{{@node1:API.count}}",
                operator: "exists",
                rightOperand: "",
              },
            ],
          },
        },
      };

      const expression = resolveConditionExpression(config);

      const outputs = {
        node1: { label: "API", data: { count: 0 } },
      };

      const result = evaluateConditionExpression(expression, outputs);
      // 0 !== null && 0 !== undefined -> true (exists)
      expect(result.result).toBe(true);
    });

    it("should handle 'doesNotExist' on null value", () => {
      const config: Record<string, unknown> = {
        conditionConfig: {
          group: {
            id: "g1",
            logic: "AND",
            rules: [
              {
                id: "r1",
                leftOperand: "{{@node1:API.value}}",
                operator: "doesNotExist",
                rightOperand: "",
              },
            ],
          },
        },
      };

      const expression = resolveConditionExpression(config);

      const outputs = {
        node1: { label: "API", data: { value: null } },
      };

      const result = evaluateConditionExpression(expression, outputs);
      expect(result.result).toBe(true);
    });
  });

  describe("array and object value edge cases", () => {
    it("should handle array length comparison", () => {
      const expression = "{{@node1:API.items.length}} > 0";
      const outputs = {
        node1: {
          label: "API",
          data: { items: { length: 3 } },
        },
      };

      const result = evaluateConditionExpression(expression, outputs);
      expect(result.result).toBe(true);
    });

    it("should handle deeply nested boolean value", () => {
      const expression = "{{@node1:API.response.success}} === true";
      const outputs = {
        node1: {
          label: "API",
          data: { response: { success: true } },
        },
      };

      const result = evaluateConditionExpression(expression, outputs);
      expect(result.result).toBe(true);
    });

    it("should handle comparing two template refs from different nodes", () => {
      const expression =
        "{{@node1:API.status}} === {{@node2:Validator.expectedStatus}}";
      const outputs = {
        node1: { label: "API", data: { status: 200 } },
        node2: { label: "Validator", data: { expectedStatus: 200 } },
      };

      const result = evaluateConditionExpression(expression, outputs);
      expect(result.result).toBe(true);
    });

    it("should correctly fail when two different node values don't match", () => {
      const expression =
        "{{@node1:API.status}} === {{@node2:Validator.expectedStatus}}";
      const outputs = {
        node1: { label: "API", data: { status: 500 } },
        node2: { label: "Validator", data: { expectedStatus: 200 } },
      };

      const result = evaluateConditionExpression(expression, outputs);
      expect(result.result).toBe(false);
    });
  });

  describe("typed operators via visual builder (boolean/array/object)", () => {
    function evalRule(
      operator: string,
      value: unknown,
      rightOperand = ""
    ): boolean {
      const config: Record<string, unknown> = {
        conditionConfig: {
          group: {
            id: "g1",
            logic: "AND",
            rules: [
              {
                id: "r1",
                leftOperand: "{{@node1:API.value}}",
                operator,
                rightOperand,
              },
            ],
          },
        },
      };

      const expression = resolveConditionExpression(config);
      const outputs = { node1: { label: "API", data: { value } } };
      return evaluateConditionExpression(expression, outputs).result;
    }

    describe("isTrue / isFalse", () => {
      it("should match a boolean true value with isTrue", () => {
        expect(evalRule("isTrue", true)).toBe(true);
      });

      it("should not treat a truthy string as isTrue", () => {
        // strict `=== true`, so the string "true" does not match
        expect(evalRule("isTrue", "true")).toBe(false);
      });

      it("should match a boolean false value with isFalse", () => {
        expect(evalRule("isFalse", false)).toBe(true);
      });

      it("should not treat 0 as isFalse", () => {
        expect(evalRule("isFalse", 0)).toBe(false);
      });
    });

    describe("arrayIsEmpty / arrayIsNotEmpty", () => {
      it("should report an empty array as empty", () => {
        expect(evalRule("arrayIsEmpty", [])).toBe(true);
      });

      it("should report a populated array as not empty", () => {
        expect(evalRule("arrayIsNotEmpty", [1, 2, 3])).toBe(true);
      });

      it("should evaluate arrayIsEmpty to false on a non-array (no throw)", () => {
        // The Array.isArray guard means a string is not "an empty array"
        expect(evalRule("arrayIsEmpty", "not an array")).toBe(false);
      });

      it("should evaluate arrayIsEmpty to false on null (no throw)", () => {
        expect(evalRule("arrayIsEmpty", null)).toBe(false);
      });

      it("should evaluate arrayIsNotEmpty to false on a non-array (no throw)", () => {
        expect(evalRule("arrayIsNotEmpty", 42)).toBe(false);
      });
    });

    describe("arrayContains", () => {
      it("should detect a present numeric element", () => {
        expect(evalRule("arrayContains", [1, 2, 3], "2")).toBe(true);
      });

      it("should detect a present string element", () => {
        expect(evalRule("arrayContains", ["a", "b"], "b")).toBe(true);
      });

      it("should return false when the element is absent", () => {
        expect(evalRule("arrayContains", [1, 2, 3], "9")).toBe(false);
      });

      it("should evaluate to false on a non-array (no throw)", () => {
        expect(evalRule("arrayContains", "abc", "a")).toBe(false);
      });
    });

    describe("arrayLength", () => {
      it("should match the exact length", () => {
        expect(evalRule("arrayLength", [1, 2, 3], "3")).toBe(true);
      });

      it("should not match a different length", () => {
        expect(evalRule("arrayLength", [1, 2], "3")).toBe(false);
      });

      it("should evaluate to false on a non-array (no throw)", () => {
        expect(evalRule("arrayLength", "abc", "3")).toBe(false);
      });
    });

    describe("objectIsEmpty", () => {
      it("should report an object with no keys as empty", () => {
        expect(evalRule("objectIsEmpty", {})).toBe(true);
      });

      it("should report an object with keys as not empty", () => {
        expect(evalRule("objectIsEmpty", { a: 1 })).toBe(false);
      });

      it("should evaluate to false on null (no throw)", () => {
        expect(evalRule("objectIsEmpty", null)).toBe(false);
      });
    });

    describe("objectHasKey", () => {
      it("should detect a present key", () => {
        expect(evalRule("objectHasKey", { id: 1, name: "x" }, "id")).toBe(true);
      });

      it("should return false for an absent key", () => {
        expect(evalRule("objectHasKey", { id: 1 }, "missing")).toBe(false);
      });

      it("should evaluate to false on null (no throw)", () => {
        expect(evalRule("objectHasKey", null, "id")).toBe(false);
      });
    });
  });

  describe("BigInt-safe comparisons for large Web3 values", () => {
    it("should detect off-by-one difference in large numbers", () => {
      const expression = "{{@node1:Contract.balance}} > 1000000000000000000";
      const outputs = {
        node1: {
          label: "Contract",
          data: { balance: "1000000000000000001" },
        },
      };

      const result = evaluateConditionExpression(expression, outputs);
      // Without BigInt: both lose precision to 1e18, comparison becomes 1e18 > 1e18 = false
      // With BigInt: 1000000000000000001n > 1000000000000000000n = true
      expect(result.result).toBe(true);
    });

    it("should handle mixed large and small values in BigInt mode", () => {
      const expression = "{{@node1:Contract.balance}} > 100";
      const outputs = {
        node1: {
          label: "Contract",
          data: { balance: "2000000000000000000" },
        },
      };

      const result = evaluateConditionExpression(expression, outputs);
      // BigInt mode triggers due to large balance; 100 also converted to BigInt
      expect(result.result).toBe(true);
    });

    it("should not trigger BigInt mode for small safe integers", () => {
      const expression = "{{@node1:API.count}} > 50";
      const outputs = {
        node1: { label: "API", data: { count: 100 } },
      };

      const result = evaluateConditionExpression(expression, outputs);
      expect(result.result).toBe(true);
    });

    it("should handle equality of two large values from different nodes", () => {
      const expression =
        "{{@node1:Contract.balance}} === {{@node2:Expected.value}}";
      const outputs = {
        node1: {
          label: "Contract",
          data: { balance: "9007199254740993" },
        },
        node2: {
          label: "Expected",
          data: { value: "9007199254740993" },
        },
      };

      const result = evaluateConditionExpression(expression, outputs);
      // Both are large integer strings -> BigInt mode -> exact comparison
      expect(result.result).toBe(true);
    });

    it("should correctly fail equality when large values differ by one", () => {
      const expression =
        "{{@node1:Contract.balance}} === {{@node2:Expected.value}}";
      const outputs = {
        node1: {
          label: "Contract",
          data: { balance: "9007199254740993" },
        },
        node2: {
          label: "Expected",
          data: { value: "9007199254740992" },
        },
      };

      const result = evaluateConditionExpression(expression, outputs);
      // Without BigInt these would both become 9007199254740992 and match
      // With BigInt: 9007199254740993n !== 9007199254740992n
      expect(result.result).toBe(false);
    });

    it("should handle >= comparison with large numbers", () => {
      const expression = "{{@node1:Contract.balance}} >= 1000000000000000000";
      const outputs = {
        node1: {
          label: "Contract",
          data: { balance: "1000000000000000000" },
        },
      };

      const result = evaluateConditionExpression(expression, outputs);
      expect(result.result).toBe(true);
    });

    it("should handle small literal on left vs large string value on right", () => {
      const expression = "100 === {{@node1:Contract.balance}}";
      const outputs = {
        node1: {
          label: "Contract",
          data: { balance: "412123123123124124124124134123" },
        },
      };

      const result = evaluateConditionExpression(expression, outputs);
      // BigInt mode: BigInt(100) === BigInt("412123123123124124124124134123") -> false
      expect(result.result).toBe(false);
    });

    it("should handle both sides as template refs from contract outputs", () => {
      const expression =
        "{{@node1:ReadBalance.result}} > {{@node2:ReadThreshold.result}}";
      const outputs = {
        node1: {
          label: "ReadBalance",
          data: { result: "5000000000000000000" },
        },
        node2: {
          label: "ReadThreshold",
          data: { result: "1000000000000000000" },
        },
      };

      const result = evaluateConditionExpression(expression, outputs);
      // Both are string values from contract outputs, BigInt mode handles them
      expect(result.result).toBe(true);
    });

    it("should compare small number operand against large contract string output", () => {
      const expression =
        "{{@node1:ReadContract.result}} > {{@node2:Config.minBalance}}";
      const outputs = {
        node1: {
          label: "ReadContract",
          data: { result: "412123123123124124124124134123" },
        },
        node2: {
          label: "Config",
          data: { minBalance: 100 },
        },
      };

      const result = evaluateConditionExpression(expression, outputs);
      // BigInt mode: BigInt("412123...") > BigInt(100) -> true
      expect(result.result).toBe(true);
    });

    it("should not break string comparisons when BigInt mode is not triggered", () => {
      const expression = '{{@node1:API.status}} === "success"';
      const outputs = {
        node1: { label: "API", data: { status: "success" } },
      };

      const result = evaluateConditionExpression(expression, outputs);
      expect(result.result).toBe(true);
    });
  });

  describe("combined visual rules with mixed types", () => {
    it("should evaluate AND condition where both rules must pass", () => {
      const config: Record<string, unknown> = {
        conditionConfig: {
          group: {
            id: "g1",
            logic: "AND",
            rules: [
              {
                id: "r1",
                leftOperand: "{{@node1:API.status}}",
                operator: "===",
                rightOperand: "200",
              },
              {
                id: "r2",
                leftOperand: "{{@node1:API.body}}",
                operator: "isNotEmpty",
                rightOperand: "",
              },
            ],
          },
        },
      };

      const expression = resolveConditionExpression(config);

      const outputs = {
        node1: {
          label: "API",
          data: { status: 200, body: "response data" },
        },
      };

      const result = evaluateConditionExpression(expression, outputs);
      expect(result.result).toBe(true);
    });

    it("should fail AND condition when one rule fails", () => {
      const config: Record<string, unknown> = {
        conditionConfig: {
          group: {
            id: "g1",
            logic: "AND",
            rules: [
              {
                id: "r1",
                leftOperand: "{{@node1:API.status}}",
                operator: "===",
                rightOperand: "200",
              },
              {
                id: "r2",
                leftOperand: "{{@node1:API.body}}",
                operator: "isNotEmpty",
                rightOperand: "",
              },
            ],
          },
        },
      };

      const expression = resolveConditionExpression(config);

      const outputs = {
        node1: { label: "API", data: { status: 200, body: "" } },
      };

      const result = evaluateConditionExpression(expression, outputs);
      expect(result.result).toBe(false);
    });

    it("should pass OR condition when only one rule passes", () => {
      const config: Record<string, unknown> = {
        conditionConfig: {
          group: {
            id: "g1",
            logic: "OR",
            rules: [
              {
                id: "r1",
                leftOperand: "{{@node1:API.status}}",
                operator: "===",
                rightOperand: "200",
              },
              {
                id: "r2",
                leftOperand: "{{@node1:API.status}}",
                operator: "===",
                rightOperand: "201",
              },
            ],
          },
        },
      };

      const expression = resolveConditionExpression(config);

      const outputs = {
        node1: { label: "API", data: { status: 201 } },
      };

      const result = evaluateConditionExpression(expression, outputs);
      expect(result.result).toBe(true);
    });
  });
});

describe("dead-branch grace: references to nodes that never executed", () => {
  // A convergence Condition (e.g. "Already scheduled?") joins two
  // mutually-exclusive branches and references a node from each, using
  // doesNotExist / === undefined to handle whichever branch did not run. When
  // nodeMap + executionResults are supplied, a reference to a graph node that
  // never executed resolves to `undefined` instead of throwing. The For Each
  // body must pass that context so a loop-body Condition behaves like a
  // top-level one.
  const deadNodeMap = new Map<string, unknown>([
    ["dead", { id: "dead", data: { label: "Query Transaction History" } }],
  ]);

  it("resolves a reference to a non-executed graph node to undefined (no throw)", () => {
    const expression =
      "({{@dead:Query Transaction History.matchCount}} === null || {{@dead:Query Transaction History.matchCount}} === undefined)";
    const result = evaluateConditionExpression(expression, {}, deadNodeMap, {});
    expect(result.result).toBe(true);
  });

  it("reports a non-executed reference as 'undefined' in resolvedValues, not null", () => {
    // The logged values panel must preserve the null/undefined distinction so a
    // strict isNull (=== null) check is not mistaken for a match: a non-executed
    // branch node is undefined, not null.
    const expression =
      "{{@dead:Query Transaction History.matchCount}} === undefined";
    const result = evaluateConditionExpression(expression, {}, deadNodeMap, {});
    expect(result.result).toBe(true);
    expect(result.resolvedValues["Query Transaction History.matchCount"]).toBe(
      "undefined"
    );
  });

  it("keeps a real null value as null in resolvedValues (not 'undefined')", () => {
    // A node that executed and produced a genuine null must stay null, so null
    // and undefined remain distinguishable in the display.
    const expression =
      "{{@ran:Check if already scheduled?.matchCount}} === null";
    const outputs = {
      ran: { label: "Check if already scheduled?", data: { matchCount: null } },
    };
    const result = evaluateConditionExpression(expression, outputs);
    expect(result.result).toBe(true);
    expect(
      result.resolvedValues["Check if already scheduled?.matchCount"]
    ).toBeNull();
  });

  it("evaluates a convergence condition when one referenced branch ran and the other did not", () => {
    const expression =
      "{{@ran:Check if already scheduled?.matchCount}} == 0 && ({{@dead:Query Transaction History.matchCount}} === null || {{@dead:Query Transaction History.matchCount}} === undefined)";
    const outputs = {
      ran: { label: "Check if already scheduled?", data: { matchCount: 0 } },
    };
    const nodeMap = new Map<string, unknown>([
      ["ran", { id: "ran" }],
      ["dead", { id: "dead" }],
    ]);
    const result = evaluateConditionExpression(expression, outputs, nodeMap, {
      ran: { success: true },
    });
    expect(result.result).toBe(true);
  });

  it("throws without the dead-branch context (the pre-fix For Each body behaviour)", () => {
    const expression =
      "{{@dead:Query Transaction History.matchCount}} === undefined";
    expect(() => evaluateConditionExpression(expression, {})).toThrow(
      NO_OUTPUT_FOUND_RE
    );
  });
});

describe("A-01: condition expressions cannot execute arbitrary code", () => {
  it("rejects a bare global call that the regex validator lets through (SSRF vector)", () => {
    // `fetch(...)` passes the legacy regex blocklist (no blocked keyword, not a
    // `.method(` call) but must never reach a real fetch under the AST interpreter.
    expect(() =>
      evaluateConditionExpression('fetch("http://127.0.0.1/")', {})
    ).toThrow(FAILED_TO_EVALUATE_RE);
  });

  it("rejects unicode-escaped constructor access (RCE vector)", () => {
    expect(() =>
      evaluateConditionExpression('"x"["\\u0063onstructor"]', {})
    ).toThrow(FAILED_TO_EVALUATE_RE);
  });

  it("rejects the full constructor-of-constructor RCE chain", () => {
    expect(() =>
      evaluateConditionExpression(
        '"x"["\\u0063onstructor"]["\\u0063onstructor"]("return 1")()',
        {}
      )
    ).toThrow(FAILED_TO_EVALUATE_RE);
  });
});

describe("resolvedExpression", () => {
  it("substitutes resolved values into the expression, quoting strings", () => {
    const expression =
      '{{@n:Get owners.result[0]}} == "0x6924f2737145455bBF5B7412DfaDCB785e26f055"';
    const outputs = {
      n: {
        label: "Get owners",
        data: { result: ["0x1Ec3e8A383Cd2084E8bb404cd8999b393db80D57"] },
      },
    };

    const result = evaluateConditionExpression(expression, outputs);
    expect(result.result).toBe(false);
    expect(result.resolvedExpression).toBe(
      '"0x1Ec3e8A383Cd2084E8bb404cd8999b393db80D57" == "0x6924f2737145455bBF5B7412DfaDCB785e26f055"'
    );
  });

  it("renders numeric and boolean references without quotes", () => {
    const expression = "{{@a:A.count}} > 10 && {{@b:B.flag}} === true";
    const outputs = {
      a: { label: "A", data: { count: 42 } },
      b: { label: "B", data: { flag: true } },
    };

    const result = evaluateConditionExpression(expression, outputs);
    expect(result.result).toBe(true);
    expect(result.resolvedExpression).toBe("42 > 10 && true === true");
  });

  it("is omitted for a boolean expression", () => {
    const result = evaluateConditionExpression(true, {});
    expect(result.result).toBe(true);
    expect(result.resolvedExpression).toBeUndefined();
  });

  it("renders a genuine null reference as the null keyword", () => {
    const expression = "{{@n:A.matchCount}} === null";
    const outputs = { n: { label: "A", data: { matchCount: null } } };

    const result = evaluateConditionExpression(expression, outputs);
    expect(result.result).toBe(true);
    expect(result.resolvedExpression).toBe("null === null");
  });

  it("renders a non-executed reference as the undefined keyword", () => {
    const nodeMap = new Map<string, unknown>([
      ["dead", { id: "dead", data: { label: "Dead" } }],
    ]);
    const expression = "{{@dead:Dead.matchCount}} === undefined";

    const result = evaluateConditionExpression(expression, {}, nodeMap, {});
    expect(result.result).toBe(true);
    expect(result.resolvedExpression).toBe("undefined === undefined");
  });
});
