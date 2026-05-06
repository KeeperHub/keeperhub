import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { insertedRows, mockDb, mockLogSystemError } = vi.hoisted(() => {
  const rows: Array<{ table: string; values: Record<string, unknown> }> = [];
  const insert = vi.fn(
    (schema: { _: { name: string } } | { name?: string }) => ({
      values: vi.fn((values: Record<string, unknown>): Promise<void> => {
        const tableName =
          (schema as { _: { name: string } })._?.name ??
          (schema as { name?: string }).name ??
          "unknown";
        rows.push({ table: tableName, values });
        return Promise.resolve();
      }),
    })
  );
  return {
    insertedRows: rows,
    mockDb: { insert },
    mockLogSystemError: vi.fn(),
  };
});

vi.mock("@/lib/db", () => ({
  db: mockDb,
}));

vi.mock("@/lib/db/schema", () => ({
  workflowExecutions: { _: { name: "workflow_executions" } },
  directExecutions: { _: { name: "direct_executions" } },
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { DATABASE: "database" },
  logSystemError: mockLogSystemError,
}));

import {
  recordBlockedDirectExecution,
  recordBlockedWorkflowExecution,
} from "@/lib/billing/record-blocked-execution";

beforeEach(() => {
  vi.clearAllMocks();
  insertedRows.length = 0;
});

describe("recordBlockedWorkflowExecution", () => {
  it("inserts a workflow_executions row with status='blocked_billing'", async () => {
    await recordBlockedWorkflowExecution({
      workflowId: "wf_1",
      userId: "user_1",
      triggerType: "schedule",
      limitResult: {
        plan: "free",
        used: 5234,
        limit: 5000,
        debtExecutions: 0,
      },
    });

    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0].table).toBe("workflow_executions");
    expect(insertedRows[0].values).toMatchObject({
      workflowId: "wf_1",
      userId: "user_1",
      status: "blocked_billing",
    });
    const error = insertedRows[0].values.error as string;
    expect(error).toContain("free_limit_exceeded");
    expect(error).toContain("5234/5000");
    expect(error).toContain("free");
  });

  it("uses 'active_debt' reason when debtExecutions > 0", async () => {
    await recordBlockedWorkflowExecution({
      workflowId: "wf_1",
      userId: "user_1",
      triggerType: "manual",
      limitResult: {
        plan: "pro",
        used: 30_000,
        limit: 25_000,
        debtExecutions: 1500,
      },
    });

    const error = insertedRows[0].values.error as string;
    expect(error).toContain("active_debt");
  });

  it("tolerates a missing limitResult (test-mock safety)", async () => {
    await recordBlockedWorkflowExecution({
      workflowId: "wf_1",
      userId: "user_1",
      triggerType: "webhook",
      limitResult: null,
    });

    expect(insertedRows).toHaveLength(1);
    const error = insertedRows[0].values.error as string;
    expect(error).toContain("free_limit_exceeded");
    expect(error).toContain("0/0");
    expect(error).toContain("unknown");
  });

  it("does not throw when the DB insert fails -- swallows + logs", async () => {
    mockDb.insert.mockImplementationOnce(() => ({
      values: vi.fn(
        (): Promise<void> => Promise.reject(new Error("fake db failure"))
      ),
    }));

    await expect(
      recordBlockedWorkflowExecution({
        workflowId: "wf_1",
        userId: "user_1",
        triggerType: "event",
        limitResult: { plan: "free", used: 1, limit: 1, debtExecutions: 0 },
      })
    ).resolves.toBeUndefined();

    expect(mockLogSystemError).toHaveBeenCalledWith(
      "database",
      "[Billing] Failed to record blocked workflow execution",
      expect.any(Error),
      expect.objectContaining({
        workflow_id: "wf_1",
        trigger_type: "event",
      })
    );
  });
});

describe("recordBlockedDirectExecution", () => {
  it("inserts a direct_executions row with status='blocked_billing' and the trigger type", async () => {
    await recordBlockedDirectExecution({
      organizationId: "org_1",
      apiKeyId: "key_1",
      triggerType: "transfer",
      network: "ethereum",
      limitResult: {
        plan: "free",
        used: 5001,
        limit: 5000,
        debtExecutions: 0,
      },
    });

    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0].table).toBe("direct_executions");
    expect(insertedRows[0].values).toMatchObject({
      organizationId: "org_1",
      apiKeyId: "key_1",
      type: "transfer",
      network: "ethereum",
      status: "blocked_billing",
    });
  });

  it("does not throw when the DB insert fails", async () => {
    mockDb.insert.mockImplementationOnce(() => ({
      values: vi.fn(
        (): Promise<void> => Promise.reject(new Error("fake db failure"))
      ),
    }));

    await expect(
      recordBlockedDirectExecution({
        organizationId: "org_1",
        apiKeyId: "key_1",
        triggerType: "contract-call",
        limitResult: { plan: "free", used: 1, limit: 1, debtExecutions: 0 },
      })
    ).resolves.toBeUndefined();

    expect(mockLogSystemError).toHaveBeenCalledWith(
      "database",
      "[Billing] Failed to record blocked direct execution",
      expect.any(Error),
      expect.objectContaining({
        org_id: "org_1",
        trigger_type: "contract-call",
      })
    );
  });
});
