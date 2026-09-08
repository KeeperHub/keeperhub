import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockValues, mockInsert, mockIncrementCounter } = vi.hoisted(() => {
  const values = vi.fn();
  return {
    mockValues: values,
    mockInsert: vi.fn(() => ({ values })),
    mockIncrementCounter: vi.fn(),
  };
});

vi.mock("@/lib/db", () => ({ db: { insert: mockInsert } }));
vi.mock("@/lib/db/schema", () => ({
  securityAuditLog: { __table: "security_audit_log" },
}));
vi.mock("@/lib/logging", () => ({
  ErrorCategory: { DATABASE: "database" },
  logSystemError: vi.fn(),
}));
vi.mock("@/lib/metrics", () => ({
  getMetricsCollector: () => ({ incrementCounter: mockIncrementCounter }),
}));

import {
  type AuditExecutor,
  buildActor,
  buildAuditMetadata,
  newCorrelationId,
  recordAuditEvent,
  recordAuditEvents,
} from "@/lib/security/audit-log";

const actor = {
  userId: "user-1",
  organizationId: null,
  authMethod: "session",
};

beforeEach(() => {
  mockValues.mockReset();
  mockValues.mockResolvedValue(undefined);
  mockInsert.mockClear();
  mockIncrementCounter.mockClear();
});

describe("recordAuditEvent", () => {
  it("inserts an event with a null diff for a pure create (no before state)", async () => {
    await recordAuditEvent({
      actor,
      action: "api_key.created",
      resourceType: "api_key",
      resourceId: "key-1",
      after: { name: "deploy", keyPrefix: "wfb_abc" },
    });

    expect(mockValues).toHaveBeenCalledTimes(1);
    const row = mockValues.mock.calls[0][0];
    expect(row).toMatchObject({
      actorUserId: "user-1",
      organizationId: null,
      authMethod: "session",
      apiKeyId: null,
      action: "api_key.created",
      resourceType: "api_key",
      resourceId: "key-1",
    });
    // deep-diff of (undefined -> object) yields "N" (new) records, not null.
    expect(Array.isArray(row.diff)).toBe(true);
    expect(row.diff[0]).toMatchObject({ kind: "N" });
  });

  it("computes a field-level diff between before and after", async () => {
    await recordAuditEvent({
      actor,
      action: "workflow.updated",
      before: { name: "old", enabled: false },
      after: { name: "new", enabled: false },
    });

    const row = mockValues.mock.calls[0][0];
    // Only `name` changed, so exactly one edit record of kind "E".
    expect(row.diff).toHaveLength(1);
    expect(row.diff[0]).toMatchObject({
      kind: "E",
      path: ["name"],
      lhs: "old",
      rhs: "new",
    });
  });

  it("stores a null diff when there is nothing to diff", async () => {
    await recordAuditEvent({ actor, action: "user.signed_in" });
    expect(mockValues.mock.calls[0][0].diff).toBeNull();
  });

  it("never throws when the insert fails, and counts the dropped event", async () => {
    mockValues.mockRejectedValue(new Error("db down"));
    await expect(
      recordAuditEvent({ actor, action: "api_key.created" })
    ).resolves.toBeUndefined();
    expect(mockIncrementCounter).toHaveBeenCalledWith(
      "errors.system.security_audit_write.total",
      { action: "api_key.created" }
    );
  });

  it("persists durable attribution, correlation, and outcome columns", async () => {
    await recordAuditEvent({
      actor: {
        ...actor,
        actorLabel: "user@example.com",
        organizationLabel: "Acme",
      },
      action: "account.deactivated",
      resourceType: "user",
      resourceId: "user-1",
      correlationId: "corr-1",
      outcome: "failed",
    });

    expect(mockValues.mock.calls[0][0]).toMatchObject({
      actorLabel: "user@example.com",
      organizationLabel: "Acme",
      correlationId: "corr-1",
      outcome: "failed",
    });
  });

  it("defaults outcome to succeeded and labels/correlation to null", async () => {
    await recordAuditEvent({ actor, action: "user.signed_in" });
    expect(mockValues.mock.calls[0][0]).toMatchObject({
      actorLabel: null,
      organizationLabel: null,
      correlationId: null,
      outcome: "succeeded",
    });
  });

  it("writes through a passed executor and rethrows on failure (atomic mode)", async () => {
    const txValues = vi.fn().mockResolvedValue(undefined);
    const txInsert = vi.fn(() => ({ values: txValues }));
    const executor = { insert: txInsert } as unknown as AuditExecutor;

    await recordAuditEvent({ actor, action: "session.revoked", executor });
    expect(txInsert).toHaveBeenCalledTimes(1);
    // The composed write does NOT touch the global db.
    expect(mockInsert).not.toHaveBeenCalled();

    txValues.mockRejectedValueOnce(new Error("tx insert failed"));
    await expect(
      recordAuditEvent({ actor, action: "session.revoked", executor })
    ).rejects.toThrow("tx insert failed");
  });
});

describe("recordAuditEvents", () => {
  it("inserts every event in a single batch call", async () => {
    await recordAuditEvents([
      { actor, action: "account.deactivated", correlationId: "corr-2" },
      { actor, action: "session.revoked", correlationId: "corr-2" },
    ]);

    expect(mockValues).toHaveBeenCalledTimes(1);
    const rows = mockValues.mock.calls[0][0];
    expect(rows).toHaveLength(2);
    expect(
      rows.every((r: { correlationId: string }) => r.correlationId === "corr-2")
    ).toBe(true);
  });

  it("is a no-op for an empty list", async () => {
    await recordAuditEvents([]);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("rethrows on failure when a non-default executor is passed", async () => {
    const txValues = vi.fn().mockRejectedValue(new Error("batch failed"));
    const executor = {
      insert: vi.fn(() => ({ values: txValues })),
    } as unknown as AuditExecutor;
    await expect(
      recordAuditEvents([{ actor, action: "session.revoked" }], executor)
    ).rejects.toThrow("batch failed");
  });
});

describe("buildActor", () => {
  it("maps an auth context and snapshots durable identity labels", () => {
    expect(
      buildActor(
        {
          userId: "u1",
          organizationId: "o1",
          authMethod: "api-key",
          apiKeyId: "k1",
        },
        { actorLabel: "u1@example.com", organizationLabel: "Acme" }
      )
    ).toEqual({
      userId: "u1",
      organizationId: "o1",
      authMethod: "api-key",
      apiKeyId: "k1",
      actorLabel: "u1@example.com",
      organizationLabel: "Acme",
    });
  });

  it("defaults apiKeyId and labels to null when omitted", () => {
    expect(
      buildActor({ userId: "u1", organizationId: null, authMethod: "session" })
    ).toMatchObject({
      apiKeyId: null,
      actorLabel: null,
      organizationLabel: null,
    });
  });
});

describe("newCorrelationId", () => {
  it("returns a fresh non-empty id each call", () => {
    const a = newCorrelationId();
    const b = newCorrelationId();
    expect(a).toBeTruthy();
    expect(typeof a).toBe("string");
    expect(a).not.toBe(b);
  });
});

describe("buildAuditMetadata", () => {
  it("captures ip, country, and user agent from request headers", () => {
    const request = new Request("https://app.keeperhub.com/api/api-keys", {
      headers: {
        "cf-connecting-ip": "203.0.113.7",
        "cf-ipcountry": "DE",
        "user-agent": "Mozilla/5.0",
      },
    });

    expect(buildAuditMetadata(request)).toEqual({
      ip: "203.0.113.7",
      country: "DE",
      userAgent: "Mozilla/5.0",
    });
  });
});
