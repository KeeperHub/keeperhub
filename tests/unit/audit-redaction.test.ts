import { describe, expect, it } from "vitest";
import { redactAuditDiff } from "@/lib/security/audit-redaction";

describe("redactAuditDiff", () => {
  it("passes through null", () => {
    expect(redactAuditDiff(null)).toBeNull();
  });

  it("keeps non-sensitive field changes intact", () => {
    const diff = [{ kind: "E", path: ["name"], lhs: "old", rhs: "new" }];
    expect(redactAuditDiff(diff)).toEqual([
      { kind: "E", path: ["name"], lhs: "old", rhs: "new" },
    ]);
  });

  it("redacts sensitive field values but keeps the field/kind", () => {
    const diff = [{ kind: "E", path: ["token"], lhs: "abc", rhs: "def" }];
    expect(redactAuditDiff(diff)).toEqual([
      { kind: "E", path: ["token"], lhs: "[redacted]", rhs: "[redacted]" },
    ]);
  });

  it("does not redact keyPrefix (a non-secret identifier)", () => {
    const diff = [{ kind: "N", path: ["keyPrefix"], rhs: "kh_abc12" }];
    expect(redactAuditDiff(diff)).toEqual([
      { kind: "N", path: ["keyPrefix"], rhs: "kh_abc12" },
    ]);
  });

  it("redacts nested secret keys inside a whole-object change", () => {
    const diff = [
      {
        kind: "N",
        path: ["config"],
        rhs: { name: "db", password: "hunter2" },
      },
    ];
    expect(redactAuditDiff(diff)).toEqual([
      {
        kind: "N",
        path: ["config"],
        rhs: { name: "db", password: "[redacted]" },
      },
    ]);
  });
});
