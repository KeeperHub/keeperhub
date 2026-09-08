import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  extractTemplateParameters,
  resolveDisplayTemplate,
  resolveTemplateToRawValue,
} from "@/lib/workflow/executor/executor.workflow";

type NodeOutputs = Record<string, { label: string; data: unknown }>;

const HTTP_STEP_OUTPUT = {
  success: true,
  data: {
    skip: 0,
    limit: 30,
    total: 340,
    comments: [
      { id: 1, body: "Great work!", user: { id: 105, fullName: "Emma" } },
      { id: 2, body: "Nice idea!", user: { id: 149, fullName: "Wyatt" } },
    ],
  },
  status: 200,
};

function makeOutputs(
  overrides?: Partial<Record<string, { label: string; data: unknown }>>
): NodeOutputs {
  return {
    node_1: { label: "Trigger", data: { triggered: true, timestamp: 1 } },
    abc_123: { label: "HTTP Request", data: HTTP_STEP_OUTPUT },
    ...overrides,
  };
}

describe("DB template parameter extraction", () => {
  describe("extractTemplateParameters", () => {
    it("extracts stored-format template and resolves value", () => {
      const outputs = makeOutputs();
      const query =
        "INSERT INTO t(data) VALUES ({{@abc_123:HTTP Request.data.comments}}::jsonb)";
      const { parameterizedQuery, paramValues } = extractTemplateParameters(
        query,
        outputs
      );

      expect(parameterizedQuery).toBe("INSERT INTO t(data) VALUES ($1::jsonb)");
      expect(paramValues).toHaveLength(1);
      expect(paramValues[0]).toEqual(HTTP_STEP_OUTPUT.data.comments);
    });

    it("extracts display-format template and resolves value", () => {
      const outputs = makeOutputs();
      const query =
        "INSERT INTO t(data) VALUES ({{HTTP Request.data.comments}}::jsonb)";
      const { parameterizedQuery, paramValues } = extractTemplateParameters(
        query,
        outputs
      );

      expect(parameterizedQuery).toBe("INSERT INTO t(data) VALUES ($1::jsonb)");
      expect(paramValues).toHaveLength(1);
      expect(paramValues[0]).toEqual(HTTP_STEP_OUTPUT.data.comments);
    });

    it("strips surrounding single quotes from templates", () => {
      const outputs = makeOutputs();
      const query =
        "SELECT * FROM t WHERE name = '{{@abc_123:HTTP Request.data.comments[0].body}}'";
      const { parameterizedQuery } = extractTemplateParameters(query, outputs);

      expect(parameterizedQuery).toBe("SELECT * FROM t WHERE name = $1");
    });

    it("preserves leading quote when trailing quote is missing (asymmetric)", () => {
      const outputs = makeOutputs();
      const query =
        "SELECT * FROM t WHERE name = '{{@abc_123:HTTP Request.data.total}}";
      const { parameterizedQuery } = extractTemplateParameters(query, outputs);

      expect(parameterizedQuery).toBe("SELECT * FROM t WHERE name = '$1");
    });

    it("preserves trailing quote when leading quote is missing (asymmetric)", () => {
      const outputs = makeOutputs();
      const query =
        "SELECT * FROM t WHERE name = {{@abc_123:HTTP Request.data.total}}'";
      const { parameterizedQuery } = extractTemplateParameters(query, outputs);

      expect(parameterizedQuery).toBe("SELECT * FROM t WHERE name = $1'");
    });

    it("strips quotes on display-format templates symmetrically", () => {
      const outputs = makeOutputs();
      const query =
        "SELECT * FROM t WHERE name = '{{HTTP Request.data.comments[0].body}}'";
      const { parameterizedQuery } = extractTemplateParameters(query, outputs);

      expect(parameterizedQuery).toBe("SELECT * FROM t WHERE name = $1");
    });

    it("handles multiple templates in one query", () => {
      const outputs = makeOutputs();
      const query =
        "INSERT INTO t(a, b) VALUES ({{@abc_123:HTTP Request.data.total}}, {{@node_1:Trigger.timestamp}})";
      const { parameterizedQuery, paramValues } = extractTemplateParameters(
        query,
        outputs
      );

      expect(parameterizedQuery).toBe("INSERT INTO t(a, b) VALUES ($1, $2)");
      expect(paramValues).toHaveLength(2);
      expect(paramValues[0]).toBe(340);
      expect(paramValues[1]).toBe(1);
    });

    it("preserves native types (arrays, numbers, strings)", () => {
      const outputs = makeOutputs();
      const query =
        "INSERT INTO t(arr, num, txt) VALUES ({{@abc_123:HTTP Request.data.comments}}::jsonb, {{@abc_123:HTTP Request.data.total}}, {{@abc_123:HTTP Request.data.comments[0].body}})";
      const { paramValues } = extractTemplateParameters(query, outputs);

      expect(Array.isArray(paramValues[0])).toBe(true);
      expect(typeof paramValues[1]).toBe("number");
      expect(typeof paramValues[2]).toBe("string");
    });

    it("returns null for missing node reference", () => {
      const outputs = makeOutputs();
      const query = "SELECT {{@missing_node:Missing.field}}";
      const { paramValues } = extractTemplateParameters(query, outputs);

      expect(paramValues).toHaveLength(1);
      expect(paramValues[0]).toBeNull();
    });

    it("returns empty paramValues when query has no templates", () => {
      const outputs = makeOutputs();
      const query = "SELECT * FROM t WHERE id = 1";
      const { parameterizedQuery, paramValues } = extractTemplateParameters(
        query,
        outputs
      );

      expect(parameterizedQuery).toBe(query);
      expect(paramValues).toHaveLength(0);
    });
  });

  describe("resolveDisplayTemplate", () => {
    it("resolves with exact label match", () => {
      const outputs = makeOutputs();
      const result = resolveDisplayTemplate(
        "HTTP Request.data.comments",
        outputs
      );

      expect(result).toEqual(HTTP_STEP_OUTPUT.data.comments);
    });

    it("resolves with case-insensitive label match", () => {
      const outputs = makeOutputs();
      const result = resolveDisplayTemplate(
        "http request.data.comments",
        outputs
      );

      expect(result).toEqual(HTTP_STEP_OUTPUT.data.comments);
    });

    it("resolves with mixed-case label", () => {
      const outputs = makeOutputs();
      const result = resolveDisplayTemplate(
        "Http Request.data.comments",
        outputs
      );

      expect(result).toEqual(HTTP_STEP_OUTPUT.data.comments);
    });

    it("returns null when label not found", () => {
      const outputs = makeOutputs();
      const result = resolveDisplayTemplate("Unknown Node.data.field", outputs);

      expect(result).toBeNull();
    });

    it("returns null when data is null", () => {
      const outputs: NodeOutputs = {
        n1: { label: "Empty", data: null },
      };
      const result = resolveDisplayTemplate("Empty.field", outputs);

      expect(result).toBeNull();
    });

    it("returns whole output data when no field path", () => {
      const outputs = makeOutputs();
      const result = resolveDisplayTemplate("Trigger", outputs);

      expect(result).toEqual({ triggered: true, timestamp: 1 });
    });

    it("resolves nested field paths", () => {
      const outputs = makeOutputs();
      const result = resolveDisplayTemplate(
        "HTTP Request.data.comments[0].user.fullName",
        outputs
      );

      expect(result).toBe("Emma");
    });
  });

  describe("resolveTemplateToRawValue", () => {
    it("resolves by sanitized node ID", () => {
      const outputs = makeOutputs();
      const result = resolveTemplateToRawValue(
        "abc_123",
        "HTTP Request.data.total",
        outputs
      );

      expect(result).toBe(340);
    });

    it("resolves with node ID containing dashes (sanitization)", () => {
      const outputs: NodeOutputs = {
        abc_123: { label: "API", data: { value: 42 } },
      };
      const result = resolveTemplateToRawValue("abc-123", "API.value", outputs);

      expect(result).toBe(42);
    });

    it("falls back to label matching when node ID not found", () => {
      const outputs = makeOutputs();
      const result = resolveTemplateToRawValue(
        "stale_node_id",
        "HTTP Request.data.comments",
        outputs
      );

      expect(result).toEqual(HTTP_STEP_OUTPUT.data.comments);
    });

    it("label fallback is case-insensitive", () => {
      const outputs = makeOutputs();
      const result = resolveTemplateToRawValue(
        "wrong_id",
        "http request.data.total",
        outputs
      );

      expect(result).toBe(340);
    });

    it("returns null when neither ID nor label matches", () => {
      const outputs = makeOutputs();
      const result = resolveTemplateToRawValue(
        "missing",
        "Unknown.field",
        outputs
      );

      expect(result).toBeNull();
    });

    it("returns null when output data is null", () => {
      const outputs: NodeOutputs = {
        n1: { label: "Empty", data: null },
      };
      const result = resolveTemplateToRawValue("n1", "Empty.field", outputs);

      expect(result).toBeNull();
    });

    it("returns whole output when no field path in rest", () => {
      const outputs = makeOutputs();
      const result = resolveTemplateToRawValue("node_1", "Trigger", outputs);

      expect(result).toEqual({ triggered: true, timestamp: 1 });
    });
  });

  describe("real-world reproduction: HTTP Request -> Database Query", () => {
    it("resolves display-format comments template from HTTP output", () => {
      const outputs = makeOutputs();
      const query = `INSERT INTO test2(name, identifier, metadata)
VALUES ('foo', now(), {{HTTP Request.data.comments}}::jsonb) RETURNING *;`;

      const { parameterizedQuery, paramValues } = extractTemplateParameters(
        query,
        outputs
      );

      expect(parameterizedQuery).toBe(
        `INSERT INTO test2(name, identifier, metadata)
VALUES ('foo', now(), $1::jsonb) RETURNING *;`
      );
      expect(paramValues).toHaveLength(1);
      expect(Array.isArray(paramValues[0])).toBe(true);
      expect(paramValues[0]).toEqual(HTTP_STEP_OUTPUT.data.comments);
    });

    it("resolves stored-format comments template from HTTP output", () => {
      const outputs = makeOutputs();
      const query = `INSERT INTO test2(name, identifier, metadata)
VALUES ('foo', now(), {{@abc_123:HTTP Request.data.comments}}::jsonb) RETURNING *;`;

      const { paramValues } = extractTemplateParameters(query, outputs);

      expect(paramValues).toHaveLength(1);
      expect(paramValues[0]).toEqual(HTTP_STEP_OUTPUT.data.comments);
    });

    it("resolves case-insensitive display-format (deployment fix)", () => {
      const outputs: NodeOutputs = {
        n1: { label: "http request", data: HTTP_STEP_OUTPUT },
      };
      const query =
        "INSERT INTO t(data) VALUES ({{HTTP Request.data.comments}}::jsonb)";

      const { paramValues } = extractTemplateParameters(query, outputs);

      expect(paramValues).toHaveLength(1);
      expect(paramValues[0]).toEqual(HTTP_STEP_OUTPUT.data.comments);
    });
  });
});
