/**
 * Absent field paths in a condition resolve to undefined rather than throwing.
 *
 * Every reference is resolved before the expression is evaluated, so throwing
 * on an absent path also defeated an author's own `is not undefined` guard --
 * the `&&` never got to short-circuit.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { evaluateConditionExpression } from "@/lib/workflow/executor/executor.workflow";

const outputs = {
  trigger: {
    label: "Manual",
    data: {
      triggered: true,
      timestamp: 1,
      triggeredAt: "x",
      nested: { a: null },
    },
  },
};
const ABSENT = "{{@trigger:Manual.triggeredAtss}}";

describe("condition references to absent field paths", () => {
  it("lets an is-not-undefined guard short-circuit to false", () => {
    const r = evaluateConditionExpression(
      `(${ABSENT} !== undefined) && ${ABSENT} == {{@trigger:Manual.timestamp}}`,
      outputs
    );
    expect(r.result).toBe(false);
  });

  it("makes the is-undefined operator usable", () => {
    expect(
      evaluateConditionExpression(`${ABSENT} === undefined`, outputs).result
    ).toBe(true);
  });

  it("reports the absent path with the available fields", () => {
    const r = evaluateConditionExpression(`${ABSENT} === undefined`, outputs);
    expect(r.unresolvedFields).toHaveLength(1);
    expect(r.unresolvedFields?.[0]).toContain("triggeredAtss");
    expect(r.unresolvedFields?.[0]).toContain(
      "Available fields: triggered, timestamp, triggeredAt, nested"
    );
  });

  it("reports nothing when every reference resolves", () => {
    const r = evaluateConditionExpression(
      "{{@trigger:Manual.timestamp}} == 1",
      outputs
    );
    expect(r.result).toBe(true);
    expect(r.unresolvedFields).toBeUndefined();
  });

  it("keeps a present-but-null field distinct from an absent one", () => {
    const r = evaluateConditionExpression(
      "{{@trigger:Manual.nested.a}} === null",
      outputs
    );
    expect(r.result).toBe(true);
    expect(r.unresolvedFields).toBeUndefined();
  });

  it("treats a null node output as an absent path, not a throw", () => {
    const r = evaluateConditionExpression(
      "{{@blank:Blank.foo}} !== undefined",
      { ...outputs, blank: { label: "Blank", data: null } }
    );
    expect(r.result).toBe(false);
    expect(r.unresolvedFields?.[0]).toContain("null");
  });

  it("resolves a path that breaks on an intermediate segment", () => {
    for (const path of [
      "Manual.missing.deep",
      "Manual.nested.nope",
      "Manual.timestamp.x",
      "Manual.nested.a.x",
    ]) {
      const r = evaluateConditionExpression(
        `{{@trigger:${path}}} !== undefined`,
        outputs
      );
      expect(r.result).toBe(false);
      expect(r.unresolvedFields).toHaveLength(1);
    }
  });

  it("still throws when the referenced node produced no output at all", () => {
    expect(() =>
      evaluateConditionExpression("{{@nope:Nope.x}} == 1", outputs)
    ).toThrow(/no output was found/);
  });

  it("rejects an absent path under a comparison operator", () => {
    expect(() =>
      evaluateConditionExpression(`${ABSENT} > 100`, outputs)
    ).toThrow(/does not exist on the data/);
  });

  it("rejects two absent paths compared to each other", () => {
    expect(() =>
      evaluateConditionExpression(`${ABSENT} == ${ABSENT}`, outputs)
    ).toThrow(/does not exist on the data/);
  });

  it("points at the presence operators in the rejection", () => {
    expect(() =>
      evaluateConditionExpression(`${ABSENT} == 1`, outputs)
    ).toThrow(/is not undefined/);
  });

  it("supports the exists and does-not-exist shapes", () => {
    expect(
      evaluateConditionExpression(
        `${ABSENT} !== null && ${ABSENT} !== undefined`,
        outputs
      ).result
    ).toBe(false);
    expect(
      evaluateConditionExpression(
        `${ABSENT} === null || ${ABSENT} === undefined`,
        outputs
      ).result
    ).toBe(true);
  });
});
