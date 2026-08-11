import { describe, expect, it } from "vitest";
import {
  AUDIT_RETENTION_DAYS,
  auditRetentionCutoff,
} from "@/lib/security/audit-retention";

describe("auditRetentionCutoff", () => {
  it("returns the retention window before the given time", () => {
    const now = new Date("2026-06-15T00:00:00.000Z");
    const cutoff = auditRetentionCutoff(now);
    const days = (now.getTime() - cutoff.getTime()) / (24 * 60 * 60 * 1000);
    expect(days).toBe(AUDIT_RETENTION_DAYS);
  });

  it("uses a two-year window", () => {
    expect(AUDIT_RETENTION_DAYS).toBe(730);
  });
});
