/**
 * Unit tests for the simulate-flag parser.
 *
 * `simulate` on /api/execute/* must be a strict boolean. Any other
 * value (string, number, object) must be rejected with a structured
 * error so callers cannot silently fall through to a real broadcast.
 *
 * Run with: pnpm vitest tests/unit/execute-simulate-flag.test.ts
 */

import { describe, expect, it } from "vitest";
import { parseSimulateFlag } from "@/app/api/execute/_lib/simulate-flag";

describe("parseSimulateFlag", () => {
  it("returns simulate=false when the field is omitted", () => {
    const result = parseSimulateFlag({});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.simulate).toBe(false);
    }
  });

  it("returns simulate=true for boolean true", () => {
    const result = parseSimulateFlag({ simulate: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.simulate).toBe(true);
    }
  });

  it("returns simulate=false for boolean false", () => {
    const result = parseSimulateFlag({ simulate: false });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.simulate).toBe(false);
    }
  });

  it("rejects the string 'true'", () => {
    const result = parseSimulateFlag({ simulate: "true" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("must be a boolean");
    }
  });

  it("rejects the number 1", () => {
    const result = parseSimulateFlag({ simulate: 1 });
    expect(result.ok).toBe(false);
  });

  it("rejects an object", () => {
    const result = parseSimulateFlag({ simulate: { yes: true } });
    expect(result.ok).toBe(false);
  });

  it("rejects null explicitly (distinct from undefined)", () => {
    const result = parseSimulateFlag({ simulate: null });
    expect(result.ok).toBe(false);
  });
});
