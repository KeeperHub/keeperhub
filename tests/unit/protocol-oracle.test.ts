/**
 * Unit tests for checkOutputExpectation.
 *
 * checkOutputExpectation is the pure assertion layer behind the coverage
 * runner's output oracle. Tested in isolation so a regression in path
 * resolution or predicate semantics fails in `pnpm test:unit` rather than
 * surfacing as a confusing on-chain e2e failure.
 *
 * Output shapes mirror what readContractCore records: a step output of
 * `{ success, result }` where `result` is the bare value for a single
 * unnamed ABI output, or an object keyed by output name otherwise
 * (structureAbiOutputs). Numbers arrive BigInt-serialized as strings.
 */

import { describe, expect, it } from "vitest";
import { checkOutputExpectation } from "@/tests/e2e/vitest/protocol-coverage/_shared/oracle";

function output(result: unknown): unknown {
  return { success: true, result, addressLink: "" };
}

describe("checkOutputExpectation", () => {
  describe("field resolution", () => {
    it("targets result itself when field is omitted", () => {
      expect(checkOutputExpectation(output("42"), {})).toBeNull();
    });

    it("resolves a named field", () => {
      expect(
        checkOutputExpectation(output({ rate: "116" }), { field: "rate" })
      ).toBeNull();
    });

    it("resolves a dot-path into nested objects", () => {
      expect(
        checkOutputExpectation(output({ a: { b: "1" } }), { field: "a.b" })
      ).toBeNull();
    });

    it("fails when the field is missing", () => {
      expect(
        checkOutputExpectation(output({ rate: "116" }), { field: "wrong" })
      ).toContain("missing");
    });

    it("fails when result itself is missing", () => {
      expect(checkOutputExpectation({ success: true }, {})).toContain(
        "missing"
      );
    });

    it("fails on null values", () => {
      expect(
        checkOutputExpectation(output({ rate: null }), { field: "rate" })
      ).toContain("missing");
    });
  });

  describe("nonZero", () => {
    it("passes on a nonzero BigInt-serialized string", () => {
      expect(
        checkOutputExpectation(output("1166468575160238469"), {
          nonZero: true,
        })
      ).toBeNull();
    });

    it("fails on string zero", () => {
      expect(checkOutputExpectation(output("0"), { nonZero: true })).toContain(
        "nonZero"
      );
    });

    it("fails on numeric zero", () => {
      expect(checkOutputExpectation(output(0), { nonZero: true })).toContain(
        "nonZero"
      );
    });

    it("treats non-numeric strings as nonzero rather than false-failing", () => {
      expect(
        checkOutputExpectation(output("0xabc"), { nonZero: true })
      ).toBeNull();
    });
  });

  describe("notEmpty", () => {
    it("passes on a populated array", () => {
      expect(
        checkOutputExpectation(output(["0xabc"]), { notEmpty: true })
      ).toBeNull();
    });

    it("fails on an empty array", () => {
      expect(checkOutputExpectation(output([]), { notEmpty: true })).toContain(
        "notEmpty"
      );
    });

    it("fails on an empty string", () => {
      expect(checkOutputExpectation(output(""), { notEmpty: true })).toContain(
        "notEmpty"
      );
    });

    it("fails on an empty object", () => {
      expect(checkOutputExpectation(output({}), { notEmpty: true })).toContain(
        "notEmpty"
      );
    });
  });

  describe("equals", () => {
    it("matches booleans via string form", () => {
      expect(
        checkOutputExpectation(output(false), { equals: "false" })
      ).toBeNull();
    });

    it("matches numeric strings exactly", () => {
      expect(checkOutputExpectation(output("3"), { equals: "3" })).toBeNull();
    });

    it("fails on mismatch and reports both values", () => {
      const failure = checkOutputExpectation(output("3"), { equals: "4" });
      expect(failure).toContain('expected "4"');
      expect(failure).toContain('"3"');
    });
  });

  describe("predicate composition", () => {
    it("checks every predicate on one expectation", () => {
      expect(
        checkOutputExpectation(output({ threshold: "3" }), {
          field: "threshold",
          nonZero: true,
          equals: "3",
        })
      ).toBeNull();
      expect(
        checkOutputExpectation(output({ threshold: "0" }), {
          field: "threshold",
          nonZero: true,
          equals: "3",
        })
      ).toContain("nonZero");
    });
  });
});
