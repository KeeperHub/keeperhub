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

    // #2502. The fixture above is punctuation-free, which is how a scan that read
    // quoted operands as code survived a suite this thorough: the pattern has to
    // carry the characters the scan is looking for.
    it("should accept a quoted pattern carrying a character class", () => {
      const result = validateConditionExpressionUI(
        'new RegExp("^0x[0-9a-fA-F]{40}$").test(String({{@node1:Label.field}}))'
      );
      expect(result.valid).toBe(true);
    });

    it("should accept a quoted operand carrying an operator character", () => {
      // The `-` in [0-9a-fA-F] is the reported case; `/`, `*`, `+` and `%` are the
      // same scan reaching the same wrong conclusion.
      for (const value of ["-", "/", "*", "+", "%"]) {
        const result = validateConditionExpressionUI(
          `String({{@node1:Label.field}}).includes("a${value}b")`
        );
        expect(result.valid).toBe(true);
      }
    });

    it("should accept the error text the Write Contract message recommends matching", () => {
      // plugins/web3/index.ts:1836 tells authors to match this in a downstream
      // Condition, and a contains rule compiles to String(...).includes("..."),
      // so the `/` and the `-` in it are exactly this defect.
      const result = validateConditionExpressionUI(
        'String({{@node1:Label.field}}).includes("Contract call failed: Error(Splitter/kicked-too-soon)")'
      );
      expect(result.valid).toBe(true);
    });

    it("should accept a quoted operand carrying punctuation beside a real operator", () => {
      const result = validateConditionExpressionUI(
        'String({{@node1:Label.field}}).includes("a-b") && {{@b:B.y}} === "bar"'
      );
      expect(result.valid).toBe(true);
    });

    it("should still reject a spacing error outside the literal", () => {
      // The exemption is the literal's span, not the line: an operator after the
      // closing quote is read as before.
      const result = validateConditionExpressionUI(
        'String({{@node1:Label.field}}).includes("a-b")+{{@b:B.y}}'
      );
      expect(result.valid).toBe(false);
      expect(result).toEqual({
        valid: false,
        error: expect.stringContaining("must have exactly one space"),
      });
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

  describe("a template variable's span", () => {
    // The brace tally counted `{{` and `}}` in the raw text before an operator,
    // which is a second definition of a template: `TEMPLATE_VAR_PATTERN` requires
    // `{{@`, the tally counted any `{{`, and neither knew where the tokenizer had
    // already put a literal. These four are the review's two tables, in order.
    it("still reports a missing space after a template variable", () => {
      expect(
        validateConditionExpressionUI('{{@a:A.x}} === "z" && {{@b:B.y}}==="w"')
      ).toMatchObject({
        valid: false,
        error: expect.stringContaining("==="),
      });
    });

    it("reports it when a literal earlier in the expression contains {{", () => {
      // The open-count direction. The literal's braces used to leave the tally
      // open for the rest of the expression, so every operator after it was
      // skipped and the expression validated as clean: validation off, silently,
      // rather than a wrong error.
      const result = validateConditionExpressionUI(
        '{{@a:A.x}} === "{{" && {{@b:B.y}}==="w"'
      );
      expect(result).toMatchObject({
        valid: false,
        error: expect.stringContaining("==="),
      });
    });

    it("leaves a literal's braces alone when the spacing is right", () => {
      // The control for the span test rather than for the tally: a literal
      // containing `{{` with an otherwise well-spaced expression is valid on both
      // versions, and this is what stops a later widening of
      // `isInsideTemplateToken` from starting to flag a literal's braces.
      expect(validateConditionExpressionUI('{{@a:A.x}} === "{{"')).toEqual({
        valid: true,
      });
    });

    it("leaves a hyphenated node label alone", () => {
      expect(
        validateConditionExpressionUI('String({{@b:My-Node.field}}) === "z"')
      ).toEqual({ valid: true });
    });

    it("leaves it alone when a literal contains }}", () => {
      // The under-count direction, which is the first case reached by the other
      // road: the literal's closing braces consumed the real template's opening,
      // so the label was validated as code and its hyphen read as an operator.
      expect(
        validateConditionExpressionUI(
          'String({{@a:A.x}}).includes("}}") && {{@b:My-Node.field}} === "z"'
        )
      ).toEqual({ valid: true });
    });
  });
});
