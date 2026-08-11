import { describe, expect, it, vi } from "vitest";

// Mock server-only to allow importing workflow-executor in tests
vi.mock("server-only", () => ({}));

import {
  BUILTIN_NODE_ID,
  BUILTIN_NODE_LABEL,
  BUILTIN_VARIABLE_FIELDS,
  getBuiltinVariables,
} from "@/lib/workflow/editor/builtin-variables";
import { evaluateConditionExpression } from "@/lib/workflow/executor/executor.workflow";

describe("builtin-variables", () => {
  describe("getBuiltinVariables", () => {
    it("returns unixTimestamp as integer seconds", () => {
      const vars = getBuiltinVariables();
      expect(typeof vars.unixTimestamp).toBe("number");
      expect(Number.isInteger(vars.unixTimestamp)).toBe(true);
      const diff = Math.abs(
        (vars.unixTimestamp as number) - Math.floor(Date.now() / 1000)
      );
      expect(diff).toBeLessThan(2);
    });

    it("returns unixTimestampMs as integer milliseconds", () => {
      const vars = getBuiltinVariables();
      expect(typeof vars.unixTimestampMs).toBe("number");
      expect(Number.isInteger(vars.unixTimestampMs)).toBe(true);
      const diff = Math.abs((vars.unixTimestampMs as number) - Date.now());
      expect(diff).toBeLessThan(1000);
    });

    it("returns isoTimestamp as valid ISO string", () => {
      const vars = getBuiltinVariables();
      expect(typeof vars.isoTimestamp).toBe("string");
      const parsed = new Date(vars.isoTimestamp as string);
      expect(parsed.toISOString()).toBe(vars.isoTimestamp);
    });

    it("returns all three expected fields", () => {
      const vars = getBuiltinVariables();
      expect(Object.keys(vars)).toHaveLength(3);
      expect(vars).toHaveProperty("unixTimestamp");
      expect(vars).toHaveProperty("unixTimestampMs");
      expect(vars).toHaveProperty("isoTimestamp");
    });
  });

  describe("constants", () => {
    it("BUILTIN_NODE_ID is __system", () => {
      expect(BUILTIN_NODE_ID).toBe("__system");
    });

    it("BUILTIN_NODE_LABEL is System", () => {
      expect(BUILTIN_NODE_LABEL).toBe("System");
    });

    it("sanitized BUILTIN_NODE_ID equals itself", () => {
      const sanitized = BUILTIN_NODE_ID.replace(/[^a-zA-Z0-9]/g, "_");
      expect(sanitized).toBe("__system");
    });
  });

  describe("BUILTIN_VARIABLE_FIELDS", () => {
    it("contains definitions for all variables", () => {
      expect(BUILTIN_VARIABLE_FIELDS).toHaveLength(3);
      const fields = BUILTIN_VARIABLE_FIELDS.map((d) => d.field);
      expect(fields).toContain("unixTimestamp");
      expect(fields).toContain("unixTimestampMs");
      expect(fields).toContain("isoTimestamp");
    });

    it("each definition has field and description", () => {
      for (const def of BUILTIN_VARIABLE_FIELDS) {
        expect(def.field).toBeTruthy();
        expect(def.description).toBeTruthy();
      }
    });
  });
});

describe("condition evaluation with system variables", () => {
  it("resolves __system variables in condition expressions", () => {
    const outputs = {
      __system: {
        label: "System",
        data: {
          unixTimestamp: 1_700_000_000,
          unixTimestampMs: 1_700_000_000_000,
          isoTimestamp: "2023-11-14T22:13:20.000Z",
        },
      },
      read_contract_1: {
        label: "Read Contract",
        data: { endTime: 1_600_000_000 },
      },
    };

    const expression =
      "{{@read_contract_1:Read Contract.endTime}} < {{@__system:System.unixTimestamp}}";
    const result = evaluateConditionExpression(expression, outputs);
    expect(result.result).toBe(true);
  });

  it("returns false when contract timestamp is in the future", () => {
    const outputs = {
      __system: {
        label: "System",
        data: {
          unixTimestamp: 1_700_000_000,
          unixTimestampMs: 1_700_000_000_000,
          isoTimestamp: "2023-11-14T22:13:20.000Z",
        },
      },
      node1: {
        label: "Read Contract",
        data: { endTime: 1_800_000_000 },
      },
    };

    const expression =
      "{{@node1:Read Contract.endTime}} < {{@__system:System.unixTimestamp}}";
    const result = evaluateConditionExpression(expression, outputs);
    expect(result.result).toBe(false);
  });

  it("compares contract timestamp against live system time", () => {
    const futureTimestamp = Math.floor(Date.now() / 1000) + 86_400;
    const outputs = {
      __system: {
        label: "System",
        data: getBuiltinVariables(),
      },
      node1: {
        label: "Read Contract",
        data: { endTime: futureTimestamp },
      },
    };

    const expression =
      "{{@node1:Read Contract.endTime}} > {{@__system:System.unixTimestamp}}";
    const result = evaluateConditionExpression(expression, outputs);
    expect(result.result).toBe(true);
  });

  it("works with unixTimestampMs", () => {
    const outputs = {
      __system: {
        label: "System",
        data: { unixTimestampMs: 1_700_000_000_000 },
      },
      node1: {
        label: "API",
        data: { timestamp: 1_600_000_000_000 },
      },
    };

    const expression =
      "{{@node1:API.timestamp}} < {{@__system:System.unixTimestampMs}}";
    const result = evaluateConditionExpression(expression, outputs);
    expect(result.result).toBe(true);
  });
});
