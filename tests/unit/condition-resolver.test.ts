import { describe, expect, it } from "vitest";
import type {
  ConditionGroup,
  ConditionOperator,
  ConditionRule,
} from "@/lib/workflow/nodes/condition/builder-types";
import { resolveConditionExpression } from "@/lib/workflow/nodes/condition/resolver";

function makeGroup(
  logic: "AND" | "OR",
  rules: ConditionGroup["rules"]
): ConditionGroup {
  return { id: "g1", logic, rules };
}

function makeRule(
  left: string,
  operator: ConditionOperator,
  right: string
): ConditionRule {
  return { id: "r1", leftOperand: left, operator, rightOperand: right };
}

describe("resolveConditionExpression", () => {
  it("should generate expression from conditionConfig when present", () => {
    const config: Record<string, unknown> = {
      conditionConfig: {
        group: makeGroup("AND", [makeRule("{{@node1:Label.x}}", "===", "1")]),
      },
    };

    const result = resolveConditionExpression(config);
    expect(result).toBe("{{@node1:Label.x}} === 1");
  });

  it("should return condition string when conditionConfig is absent", () => {
    const config: Record<string, unknown> = {
      condition: "status === 200",
    };

    const result = resolveConditionExpression(config);
    expect(result).toBe("status === 200");
  });

  it("should prioritize conditionConfig over condition string", () => {
    const config: Record<string, unknown> = {
      condition: "old expression",
      conditionConfig: {
        group: makeGroup("AND", [makeRule("{{@node1:Label.y}}", ">", "10")]),
      },
    };

    const result = resolveConditionExpression(config);
    expect(result).toBe("{{@node1:Label.y}} > 10");
  });

  it("should return undefined when neither is present", () => {
    const config: Record<string, unknown> = {};
    const result = resolveConditionExpression(config);
    expect(result).toBeUndefined();
  });

  it("should return undefined for empty condition string", () => {
    const config: Record<string, unknown> = {
      condition: "   ",
    };

    const result = resolveConditionExpression(config);
    expect(result).toBeUndefined();
  });

  // A group with no usable rule generates "true". That is what an empty builder looks
  // like, so it must not become a gate that lets everything through.
  it("should return undefined for conditionConfig with empty rules", () => {
    const config: Record<string, unknown> = {
      conditionConfig: {
        group: makeGroup("AND", []),
      },
    };

    const result = resolveConditionExpression(config);
    expect(result).toBeUndefined();
  });

  it("should return undefined for conditionConfig with all-empty rules", () => {
    const config: Record<string, unknown> = {
      conditionConfig: {
        group: makeGroup("AND", [makeRule("", "==", "")]),
      },
    };

    const result = resolveConditionExpression(config);
    expect(result).toBeUndefined();
  });

  // The editor writes `condition` from the group it is showing, so an always-true string
  // beside a degenerate group is that group's own output, not a gate anyone authored.
  it("should return undefined for a degenerate group beside a derived 'true'", () => {
    const config: Record<string, unknown> = {
      conditionConfig: {
        group: makeGroup("AND", []),
      },
      condition: "true",
    };

    const result = resolveConditionExpression(config);
    expect(result).toBeUndefined();
  });

  it("should return undefined for a half-typed rule beside a derived 'true'", () => {
    const config: Record<string, unknown> = {
      conditionConfig: {
        group: makeGroup("AND", [makeRule("{{@n:L.a}}", "===", "")]),
      },
      condition: "true",
    };

    const result = resolveConditionExpression(config);
    expect(result).toBeUndefined();
  });

  it("should fall through to a real expression when the group is degenerate", () => {
    const config: Record<string, unknown> = {
      conditionConfig: {
        group: makeGroup("AND", []),
      },
      condition: "{{@n:L.a}} === 1",
    };

    const result = resolveConditionExpression(config);
    expect(result).toBe("{{@n:L.a}} === 1");
  });

  // handleModeSwitch clears conditionConfig when the author moves to expression mode, so a
  // bare "true" with no group beside it was typed on purpose and still counts.
  it("should keep an authored 'true' that has no group beside it", () => {
    const config: Record<string, unknown> = {
      condition: "true",
    };

    const result = resolveConditionExpression(config);
    expect(result).toBe("true");
  });

  it("should handle conditionConfig without group property", () => {
    const config: Record<string, unknown> = {
      conditionConfig: {},
      condition: "fallback === true",
    };

    const result = resolveConditionExpression(config);
    expect(result).toBe("fallback === true");
  });

  it("should handle template references in visual config", () => {
    const config: Record<string, unknown> = {
      conditionConfig: {
        group: makeGroup("AND", [
          makeRule("{{@node1:Label.value}}", ">", "100"),
        ]),
      },
    };

    const result = resolveConditionExpression(config);
    expect(result).toBe("{{@node1:Label.value}} > 100");
  });

  it("should handle OR logic in visual config", () => {
    const config: Record<string, unknown> = {
      conditionConfig: {
        group: makeGroup("OR", [
          makeRule("{{@n:L.a}}", "===", "1"),
          makeRule("{{@n:L.b}}", "===", "2"),
        ]),
      },
    };

    const result = resolveConditionExpression(config);
    expect(result).toBe("{{@n:L.a}} === 1 || {{@n:L.b}} === 2");
  });

  it("should handle non-string condition values gracefully", () => {
    const config: Record<string, unknown> = {
      condition: 42,
    };

    const result = resolveConditionExpression(config);
    expect(result).toBeUndefined();
  });
});
