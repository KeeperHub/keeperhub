import { describe, expect, it, vi } from "vitest";

// The store module loads "server-only"; stub it for vitest.
vi.mock("server-only", () => ({}));

import {
  coerceStateValue,
  resolveExpectedVersion,
  resolveTtlSeconds,
  serializedValueSize,
  setWorkflowStateValue,
  validateStateKey,
  WORKFLOW_STATE_LIMITS,
} from "@/lib/workflow/nodes/workflow-state/store";

// The store rejects invalid input before it touches the database, so these
// paths are exercisable without a live Postgres. The transactional SQL paths
// (upsert, compare-and-set, eviction, cascade) need a real engine and are
// covered by review plus CI's database-backed suites.
describe("validateStateKey", () => {
  it("trims and accepts a normal key", () => {
    expect(validateStateKey("  lastScannedBlock ")).toEqual({
      key: "lastScannedBlock",
    });
  });

  it("rejects empty and non-string keys", () => {
    expect(validateStateKey("")).toHaveProperty("error");
    expect(validateStateKey("   ")).toHaveProperty("error");
    expect(validateStateKey(undefined)).toHaveProperty("error");
    expect(validateStateKey(42)).toHaveProperty("error");
  });

  it("rejects keys over the length limit", () => {
    expect(
      validateStateKey("k".repeat(WORKFLOW_STATE_LIMITS.MAX_KEY_LENGTH + 1))
    ).toHaveProperty("error");
    expect(
      validateStateKey("k".repeat(WORKFLOW_STATE_LIMITS.MAX_KEY_LENGTH))
    ).toEqual({ key: "k".repeat(WORKFLOW_STATE_LIMITS.MAX_KEY_LENGTH) });
  });
});

describe("resolveTtlSeconds", () => {
  it("treats absent ttl as no expiry", () => {
    expect(resolveTtlSeconds(undefined)).toEqual({ seconds: null });
    expect(resolveTtlSeconds(null)).toEqual({ seconds: null });
    expect(resolveTtlSeconds("")).toEqual({ seconds: null });
  });

  it("accepts numbers and numeric strings (editor sends strings)", () => {
    expect(resolveTtlSeconds(60)).toEqual({ seconds: 60 });
    expect(resolveTtlSeconds("3600")).toEqual({ seconds: 3600 });
  });

  it("rejects non-numeric and non-positive ttl", () => {
    expect(resolveTtlSeconds("abc")).toHaveProperty("error");
    expect(resolveTtlSeconds(0)).toHaveProperty("error");
    expect(resolveTtlSeconds(-5)).toHaveProperty("error");
  });

  it("clamps an over-long ttl instead of storing a distant expiry", () => {
    expect(resolveTtlSeconds(10 * 365 * 24 * 60 * 60)).toEqual({
      seconds: WORKFLOW_STATE_LIMITS.MAX_TTL_SECONDS,
    });
  });
});

describe("resolveExpectedVersion", () => {
  it("treats absent value as no compare-and-set", () => {
    expect(resolveExpectedVersion(undefined)).toEqual({});
    expect(resolveExpectedVersion(null)).toEqual({});
    expect(resolveExpectedVersion("")).toEqual({});
  });

  it("accepts positive integers as numbers or strings", () => {
    expect(resolveExpectedVersion(7)).toEqual({ version: 7 });
    expect(resolveExpectedVersion("7")).toEqual({ version: 7 });
  });

  it("rejects zero, negatives, and non-integers", () => {
    expect(resolveExpectedVersion(0)).toHaveProperty("error");
    expect(resolveExpectedVersion(-1)).toHaveProperty("error");
    expect(resolveExpectedVersion(1.5)).toHaveProperty("error");
    expect(resolveExpectedVersion("abc")).toHaveProperty("error");
  });
});

describe("coerceStateValue", () => {
  it("stores objects, arrays, and scalars from template references as-is", () => {
    const obj = { block: 123 };
    expect(coerceStateValue(obj)).toBe(obj);
    expect(coerceStateValue(42)).toBe(42);
    expect(coerceStateValue(true)).toBe(true);
  });

  it("parses a string that is JSON object or array text", () => {
    expect(coerceStateValue('{"block": 123}')).toEqual({ block: 123 });
    expect(coerceStateValue("[1, 2, 3]")).toEqual([1, 2, 3]);
  });

  it("stores non-JSON strings unchanged, including plain text and JSON scalars", () => {
    expect(coerceStateValue("0xabc123")).toBe("0xabc123");
    expect(coerceStateValue("{not json")).toBe("{not json");
    expect(coerceStateValue("123")).toBe("123");
  });
});

describe("serializedValueSize", () => {
  it("measures the serialized UTF-8 byte length", () => {
    expect(serializedValueSize({ a: 1 })).toEqual({ bytes: 7 });
  });

  it("rejects a value over the size limit with guidance", () => {
    const result = serializedValueSize(
      "x".repeat(WORKFLOW_STATE_LIMITS.MAX_VALUE_BYTES)
    );
    expect(result).toHaveProperty("error");
    if ("error" in result) {
      expect(result.error).toContain("Database Query");
    }
  });

  it("rejects an undefined value and unserializable input", () => {
    expect(serializedValueSize(undefined)).toHaveProperty("error");
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(serializedValueSize(circular)).toHaveProperty("error");
  });
});

describe("setWorkflowStateValue input validation (pre-database)", () => {
  const scope = { organizationId: "org_1", workflowId: "wf_1" };

  it("fails on an invalid key before touching storage", async () => {
    const result = await setWorkflowStateValue(scope, "", { value: 1 });
    expect(result).toEqual({
      success: false,
      error: "State key must be a non-empty string",
      reason: "invalid",
    });
  });

  it("fails on an oversized value with the limit reason", async () => {
    const result = await setWorkflowStateValue(scope, "key", {
      value: "x".repeat(WORKFLOW_STATE_LIMITS.MAX_VALUE_BYTES + 1),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe("limit");
      expect(result.error).toContain("8192");
    }
  });
});
