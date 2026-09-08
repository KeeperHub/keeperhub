import { describe, expect, it } from "vitest";
import { isHighRiskAuditAction } from "@/lib/security/audit-alerts";

describe("isHighRiskAuditAction", () => {
  it("flags irreversible / fund-moving actions", () => {
    expect(isHighRiskAuditAction("wallet.private_key_exported")).toBe(true);
    expect(isHighRiskAuditAction("wallet.funds_withdrawn")).toBe(true);
    expect(isHighRiskAuditAction("agentic_wallet.hmac_rotated")).toBe(true);
    expect(isHighRiskAuditAction("safe_role_allowance.revoked")).toBe(true);
    expect(isHighRiskAuditAction("org.deactivated")).toBe(true);
  });

  it("does not flag routine actions", () => {
    expect(isHighRiskAuditAction("project.created")).toBe(false);
    expect(isHighRiskAuditAction("tag.updated")).toBe(false);
    expect(isHighRiskAuditAction("session.created")).toBe(false);
  });
});
