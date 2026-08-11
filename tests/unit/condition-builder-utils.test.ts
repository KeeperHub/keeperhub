import { describe, expect, it } from "vitest";

import type {
  ConditionGroup,
  ConditionRule,
} from "@/lib/workflow/nodes/condition/builder-types";
import {
  createEmptyGroup,
  createEmptyRule,
  expressionToConditionGroup,
  isUnaryOperator,
  visualConditionToExpression,
} from "@/lib/workflow/nodes/condition/builder-utils";

function rule(
  left: string,
  operator: ConditionRule["operator"],
  right = ""
): ConditionRule {
  return { id: "r1", leftOperand: left, operator, rightOperand: right };
}

function group(
  logic: "AND" | "OR",
  rules: (ConditionRule | ConditionGroup)[]
): ConditionGroup {
  return { id: "g1", logic, rules };
}

describe("condition-builder-utils", () => {
  describe("createEmptyRule", () => {
    it("should create a rule with default values", () => {
      const r = createEmptyRule();
      expect(r.id).toBeTruthy();
      expect(r.leftOperand).toBe("");
      expect(r.operator).toBe("==");
      expect(r.rightOperand).toBe("");
    });
  });

  describe("createEmptyGroup", () => {
    it("should create a group with one empty rule", () => {
      const g = createEmptyGroup();
      expect(g.id).toBeTruthy();
      expect(g.logic).toBe("AND");
      expect(g.rules).toHaveLength(1);
    });
  });

  describe("isUnaryOperator", () => {
    it("should return true for unary operators", () => {
      expect(isUnaryOperator("isEmpty")).toBe(true);
      expect(isUnaryOperator("isNotEmpty")).toBe(true);
      expect(isUnaryOperator("exists")).toBe(true);
      expect(isUnaryOperator("doesNotExist")).toBe(true);
    });

    it("should return false for binary operators", () => {
      expect(isUnaryOperator("===")).toBe(false);
      expect(isUnaryOperator("contains")).toBe(false);
      expect(isUnaryOperator("matchesRegex")).toBe(false);
    });

    it("should return true for unary boolean/array/object operators", () => {
      expect(isUnaryOperator("isTrue")).toBe(true);
      expect(isUnaryOperator("isFalse")).toBe(true);
      expect(isUnaryOperator("arrayIsEmpty")).toBe(true);
      expect(isUnaryOperator("arrayIsNotEmpty")).toBe(true);
      expect(isUnaryOperator("objectIsEmpty")).toBe(true);
    });

    it("should return false for binary array/object operators", () => {
      expect(isUnaryOperator("arrayContains")).toBe(false);
      expect(isUnaryOperator("arrayLength")).toBe(false);
      expect(isUnaryOperator("objectHasKey")).toBe(false);
    });
  });

  describe("visualConditionToExpression", () => {
    describe("comparison operators", () => {
      it("should generate loose equals expression", () => {
        const g = group("AND", [rule("status", "==", "200")]);
        expect(visualConditionToExpression(g)).toBe('"status" == 200');
      });

      it("should generate strict equals expression", () => {
        const g = group("AND", [rule("status", "===", "200")]);
        expect(visualConditionToExpression(g)).toBe('"status" === 200');
      });

      it("should generate loose not-equals expression", () => {
        const g = group("AND", [rule("status", "!=", "404")]);
        expect(visualConditionToExpression(g)).toBe('"status" != 404');
      });

      it("should generate strict not-equals expression", () => {
        const g = group("AND", [rule("status", "!==", "404")]);
        expect(visualConditionToExpression(g)).toBe('"status" !== 404');
      });

      it("should generate greater-than expression", () => {
        const g = group("AND", [rule("count", ">", "10")]);
        expect(visualConditionToExpression(g)).toBe('"count" > 10');
      });

      it("should generate greater-than-or-equal expression", () => {
        const g = group("AND", [rule("count", ">=", "10")]);
        expect(visualConditionToExpression(g)).toBe('"count" >= 10');
      });

      it("should generate less-than expression", () => {
        const g = group("AND", [rule("count", "<", "5")]);
        expect(visualConditionToExpression(g)).toBe('"count" < 5');
      });

      it("should generate less-than-or-equal expression", () => {
        const g = group("AND", [rule("count", "<=", "5")]);
        expect(visualConditionToExpression(g)).toBe('"count" <= 5');
      });
    });

    describe("string operators", () => {
      it("should generate contains expression", () => {
        const g = group("AND", [rule("name", "contains", "foo")]);
        expect(visualConditionToExpression(g)).toBe(
          'String("name").includes("foo")'
        );
      });

      it("should generate startsWith expression", () => {
        const g = group("AND", [rule("url", "startsWith", "https")]);
        expect(visualConditionToExpression(g)).toBe(
          'String("url").startsWith("https")'
        );
      });

      it("should generate endsWith expression", () => {
        const g = group("AND", [rule("file", "endsWith", ".json")]);
        expect(visualConditionToExpression(g)).toBe(
          'String("file").endsWith(".json")'
        );
      });
    });

    describe("existence operators", () => {
      it("should generate isEmpty expression", () => {
        const g = group("AND", [rule("value", "isEmpty")]);
        expect(visualConditionToExpression(g)).toBe(
          '("value" === null || "value" === undefined || "value" === "")'
        );
      });

      it("should generate isNotEmpty expression", () => {
        const g = group("AND", [rule("value", "isNotEmpty")]);
        expect(visualConditionToExpression(g)).toBe(
          '("value" !== null && "value" !== undefined && "value" !== "")'
        );
      });

      it("should generate exists expression", () => {
        const g = group("AND", [rule("data", "exists")]);
        expect(visualConditionToExpression(g)).toBe(
          '("data" !== null && "data" !== undefined)'
        );
      });

      it("should generate doesNotExist expression", () => {
        const g = group("AND", [rule("data", "doesNotExist")]);
        expect(visualConditionToExpression(g)).toBe(
          '("data" === null || "data" === undefined)'
        );
      });

      it("should generate isNull expression", () => {
        const g = group("AND", [rule("data", "isNull")]);
        expect(visualConditionToExpression(g)).toBe('("data" === null)');
      });

      it("should generate isNotNull expression", () => {
        const g = group("AND", [rule("data", "isNotNull")]);
        expect(visualConditionToExpression(g)).toBe('("data" !== null)');
      });

      it("should generate isUndefined expression", () => {
        const g = group("AND", [rule("data", "isUndefined")]);
        expect(visualConditionToExpression(g)).toBe('("data" === undefined)');
      });

      it("should generate isNotUndefined expression", () => {
        const g = group("AND", [rule("data", "isNotUndefined")]);
        expect(visualConditionToExpression(g)).toBe('("data" !== undefined)');
      });

      it("treats the null/undefined operators as unary", () => {
        expect(isUnaryOperator("isNull")).toBe(true);
        expect(isUnaryOperator("isNotNull")).toBe(true);
        expect(isUnaryOperator("isUndefined")).toBe(true);
        expect(isUnaryOperator("isNotUndefined")).toBe(true);
      });
    });

    describe("regex operator", () => {
      it("should generate matchesRegex expression", () => {
        const g = group("AND", [rule("email", "matchesRegex", "^[a-z]+@")]);
        expect(visualConditionToExpression(g)).toBe(
          'new RegExp("^[a-z]+@").test(String("email"))'
        );
      });

      it("should handle regex with special characters", () => {
        const g = group("AND", [
          rule("phone", "matchesRegex", "\\d{3}-\\d{4}"),
        ]);
        const expr = visualConditionToExpression(g);
        expect(expr).toContain("new RegExp");
        expect(expr).toContain(".test(");
      });
    });

    describe("boolean operators", () => {
      it("should generate isTrue expression", () => {
        const g = group("AND", [rule("{{@n:L.flag}}", "isTrue")]);
        expect(visualConditionToExpression(g)).toBe("{{@n:L.flag}} === true");
      });

      it("should generate isFalse expression", () => {
        const g = group("AND", [rule("{{@n:L.flag}}", "isFalse")]);
        expect(visualConditionToExpression(g)).toBe("{{@n:L.flag}} === false");
      });
    });

    describe("array operators", () => {
      it("should generate guarded arrayIsEmpty expression", () => {
        const g = group("AND", [rule("{{@n:L.items}}", "arrayIsEmpty")]);
        expect(visualConditionToExpression(g)).toBe(
          "(Array.isArray({{@n:L.items}}) && {{@n:L.items}}.length === 0)"
        );
      });

      it("should generate guarded arrayIsNotEmpty expression", () => {
        const g = group("AND", [rule("{{@n:L.items}}", "arrayIsNotEmpty")]);
        expect(visualConditionToExpression(g)).toBe(
          "(Array.isArray({{@n:L.items}}) && {{@n:L.items}}.length > 0)"
        );
      });

      it("should generate guarded arrayContains expression", () => {
        const g = group("AND", [rule("{{@n:L.items}}", "arrayContains", "5")]);
        expect(visualConditionToExpression(g)).toBe(
          "(Array.isArray({{@n:L.items}}) && {{@n:L.items}}.includes(5))"
        );
      });

      it("should generate guarded arrayLength expression", () => {
        const g = group("AND", [rule("{{@n:L.items}}", "arrayLength", "3")]);
        expect(visualConditionToExpression(g)).toBe(
          "(Array.isArray({{@n:L.items}}) && {{@n:L.items}}.length === 3)"
        );
      });
    });

    describe("object operators", () => {
      it("should generate null-guarded objectIsEmpty expression", () => {
        const g = group("AND", [rule("{{@n:L.obj}}", "objectIsEmpty")]);
        expect(visualConditionToExpression(g)).toBe(
          "({{@n:L.obj}} !== null && {{@n:L.obj}} !== undefined && Object.keys({{@n:L.obj}}).length === 0)"
        );
      });

      it("should generate null-guarded objectHasKey expression", () => {
        const g = group("AND", [rule("{{@n:L.obj}}", "objectHasKey", "id")]);
        expect(visualConditionToExpression(g)).toBe(
          '({{@n:L.obj}} !== null && {{@n:L.obj}} !== undefined && Object.keys({{@n:L.obj}}).includes("id"))'
        );
      });
    });

    describe("template references", () => {
      it("should pass template references through as-is", () => {
        const g = group("AND", [rule("{{@node1:Label.value}}", "===", "100")]);
        expect(visualConditionToExpression(g)).toBe(
          "{{@node1:Label.value}} === 100"
        );
      });

      it("should handle template references on both sides", () => {
        const g = group("AND", [rule("{{@a:A.x}}", ">", "{{@b:B.y}}")]);
        expect(visualConditionToExpression(g)).toBe("{{@a:A.x}} > {{@b:B.y}}");
      });
    });

    describe("operand wrapping", () => {
      it("should quote plain strings", () => {
        const g = group("AND", [rule("hello", "===", "world")]);
        expect(visualConditionToExpression(g)).toBe('"hello" === "world"');
      });

      it("should pass numeric values through", () => {
        const g = group("AND", [rule("42", "===", "3.14")]);
        expect(visualConditionToExpression(g)).toBe("42 === 3.14");
      });

      it("should pass signed numeric values through", () => {
        const g = group("AND", [rule("-7", ">", "-12.5")]);
        expect(visualConditionToExpression(g)).toBe("-7 > -12.5");
      });

      it("should quote hex addresses instead of treating them as numbers", () => {
        const g = group("AND", [
          rule(
            "{{@n:Get owners.result[0]}}",
            "==",
            "0x6924f2737145455bBF5B7412DfaDCB785e26f055"
          ),
        ]);
        expect(visualConditionToExpression(g)).toBe(
          '{{@n:Get owners.result[0]}} == "0x6924f2737145455bBF5B7412DfaDCB785e26f055"'
        );
      });

      it("should quote exponent-style strings instead of treating them as numbers", () => {
        const g = group("AND", [rule("code", "===", "1e5")]);
        expect(visualConditionToExpression(g)).toBe('"code" === "1e5"');
      });

      it("should pass boolean literals through", () => {
        const g = group("AND", [rule("true", "===", "false")]);
        expect(visualConditionToExpression(g)).toBe("true === false");
      });

      it("should pass null and undefined through", () => {
        const g = group("AND", [rule("null", "===", "undefined")]);
        expect(visualConditionToExpression(g)).toBe("null === undefined");
      });

      it("should pass already-quoted strings through", () => {
        const g = group("AND", [rule('"hello"', "===", "'world'")]);
        expect(visualConditionToExpression(g)).toBe("\"hello\" === 'world'");
      });

      it("should skip empty rules and return true", () => {
        const g = group("AND", [rule("", "===", "")]);
        expect(visualConditionToExpression(g)).toBe("true");
      });

      it("should skip rules with empty left operand in OR groups", () => {
        const g = group("OR", [rule("", "===", ""), rule("", "===", "")]);
        expect(visualConditionToExpression(g)).toBe("true");
      });

      it("should skip rules with empty right operand on binary operators", () => {
        const ref = "{{@node1:Label.field}}";
        const g = group("OR", [rule(ref, "===", ""), rule("", "===", "")]);
        expect(visualConditionToExpression(g)).toBe("true");
      });

      it("should keep filled rules and skip empty ones in OR group", () => {
        const ref = "{{@node1:Label.field}}";
        const g = group("OR", [
          rule(ref, "===", "true"),
          rule("", "===", ""),
          rule("", "===", ""),
        ]);
        expect(visualConditionToExpression(g)).toBe(`${ref} === true`);
      });

      it("should keep filled rules and skip empty ones in AND group", () => {
        const ref = "{{@node1:Label.field}}";
        const g = group("AND", [rule(ref, "===", "true"), rule("", "===", "")]);
        expect(visualConditionToExpression(g)).toBe(`${ref} === true`);
      });

      it("should not skip unary operators with empty right operand", () => {
        const ref = "{{@node1:Label.field}}";
        const g = group("AND", [rule(ref, "exists", "")]);
        expect(visualConditionToExpression(g)).toBe(
          `(${ref} !== null && ${ref} !== undefined)`
        );
      });

      it("should handle mixed filled and empty rules with nested groups", () => {
        const ref = "{{@node1:Label.field}}";
        const inner = group("OR", [rule("", "===", ""), rule("", "===", "")]);
        const outer = group("AND", [rule(ref, "===", "true"), inner]);
        // Inner group is all empty -> skipped, only the filled rule remains
        expect(visualConditionToExpression(outer)).toBe(`${ref} === true`);
      });
    });

    describe("logic combinators", () => {
      it("should join rules with AND", () => {
        const g = group("AND", [rule("a", "===", "1"), rule("b", "===", "2")]);
        expect(visualConditionToExpression(g)).toBe('"a" === 1 && "b" === 2');
      });

      it("should join rules with OR", () => {
        const g = group("OR", [rule("a", "===", "1"), rule("b", "===", "2")]);
        expect(visualConditionToExpression(g)).toBe('"a" === 1 || "b" === 2');
      });

      it("should return true for empty group", () => {
        const g = group("AND", []);
        expect(visualConditionToExpression(g)).toBe("true");
      });

      it("should not wrap single rule in parens", () => {
        const g = group("AND", [rule("x", "===", "1")]);
        expect(visualConditionToExpression(g)).toBe('"x" === 1');
      });
    });

    describe("nested groups", () => {
      it("should wrap nested groups in parentheses", () => {
        const inner = group("OR", [
          rule("a", "===", "1"),
          rule("b", "===", "2"),
        ]);
        const outer = group("AND", [rule("c", "===", "3"), inner]);
        expect(visualConditionToExpression(outer)).toBe(
          '"c" === 3 && ("a" === 1 || "b" === 2)'
        );
      });

      it("should handle deeply nested groups", () => {
        const deepest = group("AND", [
          rule("x", ">", "0"),
          rule("y", "<", "100"),
        ]);
        const middle = group("OR", [rule("z", "===", "true"), deepest]);
        const outer = group("AND", [rule("enabled", "===", "true"), middle]);
        const expr = visualConditionToExpression(outer);
        expect(expr).toBe(
          '"enabled" === true && ("z" === true || ("x" > 0 && "y" < 100))'
        );
      });
    });
  });

  describe("expressionToConditionGroup", () => {
    it("should return null for empty string", () => {
      expect(expressionToConditionGroup("")).toBeNull();
      expect(expressionToConditionGroup("  ")).toBeNull();
    });

    it("should return null for 'true'", () => {
      expect(expressionToConditionGroup("true")).toBeNull();
    });

    /** Parse expression and return the first rule. Throws if parsing fails. */
    function parseFirstRule(expr: string): ConditionRule {
      const result = expressionToConditionGroup(expr);
      if (result?.rules.length !== 1) {
        throw new Error(
          `Expected single-rule group, got: ${JSON.stringify(result)}`
        );
      }
      return result.rules[0] as ConditionRule;
    }

    describe("comparison operators", () => {
      it("should parse loose equals", () => {
        const r = parseFirstRule('"status" == 200');
        expect(r.leftOperand).toBe("status");
        expect(r.operator).toBe("==");
        expect(r.rightOperand).toBe("200");
      });

      it("should parse strict equals", () => {
        const r = parseFirstRule('"status" === 200');
        expect(r.leftOperand).toBe("status");
        expect(r.operator).toBe("===");
        expect(r.rightOperand).toBe("200");
      });

      it("should parse loose not-equals", () => {
        const r = parseFirstRule('"code" != 404');
        expect(r.operator).toBe("!=");
      });

      it("should parse strict not-equals", () => {
        const r = parseFirstRule('"code" !== 404');
        expect(r.operator).toBe("!==");
      });

      it("should parse greater-than", () => {
        const r = parseFirstRule('"count" > 10');
        expect(r.operator).toBe(">");
        expect(r.rightOperand).toBe("10");
      });

      it("should parse greater-than-or-equal", () => {
        const r = parseFirstRule('"count" >= 10');
        expect(r.operator).toBe(">=");
      });

      it("should parse less-than", () => {
        const r = parseFirstRule('"count" < 5');
        expect(r.operator).toBe("<");
      });

      it("should parse less-than-or-equal", () => {
        const r = parseFirstRule('"count" <= 5');
        expect(r.operator).toBe("<=");
      });
    });

    describe("string operators", () => {
      it("should parse contains", () => {
        const r = parseFirstRule('String("name").includes("foo")');
        expect(r.leftOperand).toBe("name");
        expect(r.operator).toBe("contains");
        expect(r.rightOperand).toBe("foo");
      });

      it("should parse startsWith", () => {
        const r = parseFirstRule('String("url").startsWith("https")');
        expect(r.operator).toBe("startsWith");
      });

      it("should parse endsWith", () => {
        const r = parseFirstRule('String("file").endsWith(".json")');
        expect(r.operator).toBe("endsWith");
      });
    });

    describe("existence operators", () => {
      it("should parse isEmpty", () => {
        const r = parseFirstRule(
          '("value" === null || "value" === undefined || "value" === "")'
        );
        expect(r.leftOperand).toBe("value");
        expect(r.operator).toBe("isEmpty");
      });

      it("should parse isNotEmpty", () => {
        const r = parseFirstRule(
          '("value" !== null && "value" !== undefined && "value" !== "")'
        );
        expect(r.operator).toBe("isNotEmpty");
      });

      it("should parse exists", () => {
        const r = parseFirstRule('("data" !== null && "data" !== undefined)');
        expect(r.operator).toBe("exists");
      });

      it("should parse doesNotExist", () => {
        const r = parseFirstRule('("data" === null || "data" === undefined)');
        expect(r.operator).toBe("doesNotExist");
      });

      it("should parse isNull", () => {
        const r = parseFirstRule('("data" === null)');
        expect(r.operator).toBe("isNull");
      });

      it("should parse isNotNull", () => {
        const r = parseFirstRule('("data" !== null)');
        expect(r.operator).toBe("isNotNull");
      });

      it("should parse isUndefined", () => {
        const r = parseFirstRule('("data" === undefined)');
        expect(r.operator).toBe("isUndefined");
      });

      it("should parse isNotUndefined", () => {
        const r = parseFirstRule('("data" !== undefined)');
        expect(r.operator).toBe("isNotUndefined");
      });
    });

    describe("regex operator", () => {
      it("should parse matchesRegex", () => {
        const r = parseFirstRule(
          'new RegExp("^[a-z]+@").test(String("email"))'
        );
        expect(r.leftOperand).toBe("email");
        expect(r.operator).toBe("matchesRegex");
        expect(r.rightOperand).toBe("^[a-z]+@");
      });
    });

    describe("template references", () => {
      it("should parse template reference on left side", () => {
        const r = parseFirstRule("{{@node1:Label.value}} === 100");
        expect(r.leftOperand).toBe("{{@node1:Label.value}}");
        expect(r.operator).toBe("===");
        expect(r.rightOperand).toBe("100");
      });

      it("should parse template reference with loose equals", () => {
        const r = parseFirstRule(
          "{{@w3gEica3jTc_Vjqzn-wzV:Get Native Token Balance.balanceWei}} == 0"
        );
        expect(r.leftOperand).toBe(
          "{{@w3gEica3jTc_Vjqzn-wzV:Get Native Token Balance.balanceWei}}"
        );
        expect(r.operator).toBe("==");
        expect(r.rightOperand).toBe("0");
      });

      it("should parse template references on both sides", () => {
        const r = parseFirstRule("{{@a:A.x}} > {{@b:B.y}}");
        expect(r.leftOperand).toBe("{{@a:A.x}}");
        expect(r.rightOperand).toBe("{{@b:B.y}}");
      });
    });

    /** Parse expression and return the group. Throws if parsing fails. */
    function parseGroup(expr: string): ConditionGroup {
      const result = expressionToConditionGroup(expr);
      if (!result) {
        throw new Error(`Expected group, got null for: ${expr}`);
      }
      return result;
    }

    describe("logic combinators", () => {
      it("should parse AND groups", () => {
        const result = parseGroup('"a" === 1 && "b" === 2');
        expect(result.logic).toBe("AND");
        expect(result.rules).toHaveLength(2);
      });

      it("should parse OR groups", () => {
        const result = parseGroup('"a" === 1 || "b" === 2');
        expect(result.logic).toBe("OR");
        expect(result.rules).toHaveLength(2);
      });
    });

    describe("nested groups", () => {
      it("should parse nested parenthesized groups", () => {
        const result = parseGroup('"c" === 3 && ("a" === 1 || "b" === 2)');
        expect(result.logic).toBe("AND");
        expect(result.rules).toHaveLength(2);
        const nested = result.rules[1] as ConditionGroup;
        expect(nested.logic).toBe("OR");
        expect(nested.rules).toHaveLength(2);
      });
    });

    /** Roundtrip helper: visual -> expression -> visual, returns first rule. */
    function roundtripFirstRule(g: ConditionGroup): ConditionRule {
      const expr = visualConditionToExpression(g);
      return parseFirstRule(expr);
    }

    describe("roundtrip: visual -> expression -> visual", () => {
      it("should roundtrip loose equals", () => {
        const r = roundtripFirstRule(
          group("AND", [rule("status", "==", "200")])
        );
        expect(r.leftOperand).toBe("status");
        expect(r.operator).toBe("==");
        expect(r.rightOperand).toBe("200");
      });

      it("should roundtrip strict equals", () => {
        const r = roundtripFirstRule(
          group("AND", [rule("status", "===", "200")])
        );
        expect(r.leftOperand).toBe("status");
        expect(r.operator).toBe("===");
        expect(r.rightOperand).toBe("200");
      });

      it("should roundtrip loose not-equals", () => {
        const r = roundtripFirstRule(
          group("AND", [rule("status", "!=", "404")])
        );
        expect(r.operator).toBe("!=");
      });

      it("should roundtrip strict not-equals", () => {
        const r = roundtripFirstRule(
          group("AND", [rule("status", "!==", "404")])
        );
        expect(r.operator).toBe("!==");
      });

      it("should roundtrip contains", () => {
        const r = roundtripFirstRule(
          group("AND", [rule("name", "contains", "foo")])
        );
        expect(r.operator).toBe("contains");
        expect(r.leftOperand).toBe("name");
        expect(r.rightOperand).toBe("foo");
      });

      it("should roundtrip isEmpty", () => {
        const r = roundtripFirstRule(group("AND", [rule("val", "isEmpty")]));
        expect(r.operator).toBe("isEmpty");
        expect(r.leftOperand).toBe("val");
      });

      it("should roundtrip matchesRegex", () => {
        const r = roundtripFirstRule(
          group("AND", [rule("email", "matchesRegex", "^[a-z]+@")])
        );
        expect(r.operator).toBe("matchesRegex");
        expect(r.rightOperand).toBe("^[a-z]+@");
      });

      it("should roundtrip AND with multiple rules", () => {
        const original = group("AND", [
          rule("a", ">", "10"),
          rule("b", "<", "100"),
        ]);
        const parsed = parseGroup(visualConditionToExpression(original));
        expect(parsed.logic).toBe("AND");
        expect(parsed.rules).toHaveLength(2);
      });

      it("should roundtrip nested groups", () => {
        const inner = group("OR", [
          rule("x", "===", "1"),
          rule("y", "===", "2"),
        ]);
        const original = group("AND", [rule("z", ">", "0"), inner]);
        const parsed = parseGroup(visualConditionToExpression(original));
        expect(parsed.logic).toBe("AND");
        expect(parsed.rules).toHaveLength(2);
        const nestedGroup = parsed.rules[1] as ConditionGroup;
        expect(nestedGroup.logic).toBe("OR");
        expect(nestedGroup.rules).toHaveLength(2);
      });

      it("should roundtrip template references", () => {
        const r = roundtripFirstRule(
          group("AND", [rule("{{@node1:Label.value}}", ">=", "100")])
        );
        expect(r.leftOperand).toBe("{{@node1:Label.value}}");
        expect(r.operator).toBe(">=");
        expect(r.rightOperand).toBe("100");
      });
    });

    describe("bare value (truthy check)", () => {
      it("should parse a template reference as exists", () => {
        const r = parseFirstRule(
          "{{@process:Handle Events Results.result.hasAnomalies}}"
        );
        expect(r.leftOperand).toBe(
          "{{@process:Handle Events Results.result.hasAnomalies}}"
        );
        expect(r.operator).toBe("exists");
        expect(r.rightOperand).toBe("");
      });

      it("should parse a bare string as exists", () => {
        const r = parseFirstRule('"myFlag"');
        expect(r.leftOperand).toBe("myFlag");
        expect(r.operator).toBe("exists");
      });

      it("should parse a bare number as exists", () => {
        const r = parseFirstRule("42");
        expect(r.leftOperand).toBe("42");
        expect(r.operator).toBe("exists");
      });
    });
  });
});
