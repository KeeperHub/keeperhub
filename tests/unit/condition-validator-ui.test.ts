import { describe, expect, it } from "vitest";

import { validateConditionExpressionUI } from "@/lib/workflow/nodes/condition/validator";

describe("validateConditionExpressionUI", () => {
  describe("empty and whitespace expressions", () => {
    it("should accept empty string", () => {
      expect(validateConditionExpressionUI("")).toEqual({ valid: true });
    });

    it("should accept whitespace-only string", () => {
      expect(validateConditionExpressionUI("   ")).toEqual({ valid: true });
    });
  });

  describe("simple comparisons", () => {
    it("should accept template === string", () => {
      const result = validateConditionExpressionUI(
        '{{@node1:Label.field}} === "foo"'
      );
      expect(result.valid).toBe(true);
    });

    it("should accept template !== number", () => {
      const result = validateConditionExpressionUI(
        "{{@node1:Label.field}} !== 42"
      );
      expect(result.valid).toBe(true);
    });

    it("should accept template > template", () => {
      const result = validateConditionExpressionUI("{{@a:A.x}} > {{@b:B.y}}");
      expect(result.valid).toBe(true);
    });

    it("should accept equality with boolean literals", () => {
      const result = validateConditionExpressionUI(
        "{{@node1:Label.field}} === true"
      );
      expect(result.valid).toBe(true);
    });

    it("should accept equality with null", () => {
      const result = validateConditionExpressionUI(
        "{{@node1:Label.field}} === null"
      );
      expect(result.valid).toBe(true);
    });
  });

  describe("logical operators", () => {
    it("should accept && between comparisons", () => {
      const result = validateConditionExpressionUI(
        '{{@a:A.x}} === "a" && {{@b:B.y}} === "b"'
      );
      expect(result.valid).toBe(true);
    });

    it("should accept || between comparisons", () => {
      const result = validateConditionExpressionUI(
        '{{@a:A.x}} === "a" || {{@b:B.y}} === "b"'
      );
      expect(result.valid).toBe(true);
    });
  });

  describe("unary operators", () => {
    it("should accept ! before operand", () => {
      const result = validateConditionExpressionUI("!{{@node1:Label.field}}");
      expect(result.valid).toBe(true);
    });

    it("should reject unary minus after binary operator (pre-existing limitation)", () => {
      const result = validateConditionExpressionUI(
        "{{@node1:Label.field}} === -1"
      );
      expect(result).toMatchObject({
        valid: false,
        error: expect.stringContaining("Consecutive operators"),
      });
    });
  });

  describe("parenthesized expressions", () => {
    it("should accept parenthesized comparison", () => {
      const result = validateConditionExpressionUI('({{@a:A.x}} === "a")');
      expect(result.valid).toBe(true);
    });

    it("should accept grouped logic", () => {
      const result = validateConditionExpressionUI(
        '({{@a:A.x}} === "a") && ({{@b:B.y}} !== "b")'
      );
      expect(result.valid).toBe(true);
    });
  });

  describe("visual builder method-call expressions", () => {
    it("should accept contains: String(ref).includes(value)", () => {
      const result = validateConditionExpressionUI(
        'String({{@node1:Label.field}}).includes("foo")'
      );
      expect(result.valid).toBe(true);
    });

    it("should accept startsWith: String(ref).startsWith(value)", () => {
      const result = validateConditionExpressionUI(
        'String({{@node1:Label.field}}).startsWith("bar")'
      );
      expect(result.valid).toBe(true);
    });

    it("should accept endsWith: String(ref).endsWith(value)", () => {
      const result = validateConditionExpressionUI(
        'String({{@node1:Label.field}}).endsWith("baz")'
      );
      expect(result.valid).toBe(true);
    });

    it("should accept matchesRegex: new RegExp(pattern).test(String(ref))", () => {
      const result = validateConditionExpressionUI(
        'new RegExp("pattern").test(String({{@node1:Label.field}}))'
      );
      expect(result.valid).toBe(true);
    });

    it("should accept method call combined with logical operator", () => {
      const result = validateConditionExpressionUI(
        'String({{@a:A.x}}).includes("foo") && {{@b:B.y}} === "bar"'
      );
      expect(result.valid).toBe(true);
    });
  });

  describe("arithmetic expressions", () => {
    it("should accept addition", () => {
      const result = validateConditionExpressionUI("{{@a:A.x}} + 1 > 10");
      expect(result.valid).toBe(true);
    });

    it("should accept modulo", () => {
      const result = validateConditionExpressionUI("{{@a:A.x}} % 2 === 0");
      expect(result.valid).toBe(true);
    });
  });

  describe("spacing validation", () => {
    it("should reject extra spaces before operator", () => {
      const result = validateConditionExpressionUI(
        '{{@node1:Label.field}}  === "foo"'
      );
      expect(result).toMatchObject({
        valid: false,
        error: expect.stringContaining("Extra spaces"),
      });
    });

    it("should reject extra spaces after operator", () => {
      const result = validateConditionExpressionUI(
        '{{@node1:Label.field}} ===  "foo"'
      );
      expect(result).toMatchObject({
        valid: false,
        error: expect.stringContaining("Extra spaces"),
      });
    });

    it("should reject missing space before operator", () => {
      const result = validateConditionExpressionUI(
        '{{@node1:Label.field}}=== "foo"'
      );
      expect(result).toMatchObject({
        valid: false,
        error: expect.stringContaining("must have exactly one space"),
      });
    });

    it("should reject missing space after operator", () => {
      const result = validateConditionExpressionUI(
        '{{@node1:Label.field}} ==="foo"'
      );
      expect(result).toMatchObject({
        valid: false,
        error: expect.stringContaining("must have exactly one space"),
      });
    });
  });

  describe("invalid expressions", () => {
    it("should reject expression starting with binary operator", () => {
      const result = validateConditionExpressionUI('=== "foo"');
      expect(result).toMatchObject({
        valid: false,
        error: expect.stringContaining("cannot start with operator"),
      });
    });

    it("should reject expression ending with binary operator", () => {
      const result = validateConditionExpressionUI(
        "{{@node1:Label.field}} ==="
      );
      expect(result).toMatchObject({
        valid: false,
        error: expect.stringContaining("missing"),
      });
    });

    it("should reject consecutive binary operators", () => {
      const result = validateConditionExpressionUI(
        '{{@node1:Label.field}} === === "foo"'
      );
      expect(result).toMatchObject({
        valid: false,
        error: expect.stringContaining("Consecutive operators"),
      });
    });

    it("should reject invalid characters", () => {
      const result = validateConditionExpressionUI(
        '{{@node1:Label.field}} === "foo" & "bar"'
      );
      expect(result).toMatchObject({
        valid: false,
        error: expect.stringContaining("Invalid character"),
      });
    });
  });
});
