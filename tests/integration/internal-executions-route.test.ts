import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// --- Authentication: always authenticated as the scheduler service. ---
const mockAuthResult = {
  authenticated: true,
  caller: "scheduler" as const,
  scheme: "hmac" as const,
  error: "Unauthorized",
  status: 401,
};
vi.mock("@/lib/internal-service-auth", () => ({
  authenticateInternalService: vi.fn(async () => mockAuthResult),
}));

// --- Guards: default to allowed; tests flip these as needed. ---
const enforceExecutionLimit = vi.fn(
  async (..._args: unknown[]) => ({ blocked: false }) as { blocked: boolean }
);
vi.mock("@/lib/billing/execution-guard", () => ({
  enforceExecutionLimit: (...args: unknown[]) => enforceExecutionLimit(...args),
}));

const enforceWorkflowFeatures = vi.fn(
  async (..._args: unknown[]) => ({ blocked: false }) as { blocked: boolean }
);
vi.mock("@/lib/features/route-guard", () => ({
  enforceWorkflowFeatures: (...args: unknown[]) =>
    enforceWorkflowFeatures(...args),
}));
vi.mock("@/lib/features", () => ({
  extractActionTypeNodes: vi.fn(() => []),
}));

// Admission for phantom creates: defaults to admitted (null), tests flip it.
const checkDispatchAdmission = vi.fn(
  async (..._args: unknown[]) =>
    null as { reason: string; message: string } | null
);
vi.mock("@/lib/billing/dispatch-admission", () => ({
  checkDispatchAdmission: (...args: unknown[]) =>
    checkDispatchAdmission(...args),
}));

// withBackstopCapture wraps the insert; just run the callback.
vi.mock("@/lib/security/backstop-capture", () => ({
  withBackstopCapture: vi.fn((_ctx: unknown, fn: () => unknown) => fn()),
}));

// Record the source buildAttribution was called with so trigger-source
// passthrough can be asserted.
const buildAttribution = vi.fn((input: { source: string }) => ({
  triggerSource: input.source,
}));
vi.mock("@/lib/security/request-attribution", () => ({
  buildAttribution: (input: { source: string }) => buildAttribution(input),
}));

// The route calls buildAttribution({ request, source }); assert on source only.
const sourceArg = (source: string) => expect.objectContaining({ source });

// --- DB mock: records insert values and update payloads. ---
let mockWorkflow: {
  organizationId: string | null;
  deletedAt: Date | null;
  nodes: unknown[];
  userId: string;
} | null;
let mockExistingExecution: { id: string; status: string } | null;
let insertedValues: Record<string, unknown> | null;
let updatedSet: Record<string, unknown> | null;
// Rows the create INSERT's .onConflictDoNothing().returning() resolves to.
// Empty simulates a dispatch-key conflict (another dispatcher won the race).
let mockInsertReturning: Array<{ id: string }> = [{ id: "exec_created" }];
// Rows the dedup fallback SELECT resolves to when the insert conflicted.
let mockSelectResult: Array<{ id: string }> = [];
// Rows the PATCH terminal UPDATE's .returning() resolves to; seed with
// workflowId + previousStatus to exercise the counter-emission gate.
let mockUpdateReturning: Array<{
  workflowId: string;
  previousStatus: string;
}> = [];

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      workflows: {
        findFirst: vi.fn(async () => mockWorkflow),
      },
      workflowExecutions: {
        findFirst: vi.fn(async () => mockExistingExecution),
      },
    },
    insert: vi.fn(() => ({
      values: (values: Record<string, unknown>) => {
        insertedValues = values;
        return {
          onConflictDoNothing: () => ({
            returning: () => mockInsertReturning,
          }),
        };
      },
    })),
    // Dedup fallback lookup when the insert conflicts on dispatch_key.
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(mockSelectResult),
        }),
      }),
    })),
    // PATCH chains .set().from(prevExecution).where().returning() for the
    // pre-update-status self-join.
    update: vi.fn(() => ({
      set: (values: Record<string, unknown>) => {
        updatedSet = values;
        return {
          from: () => ({
            where: () => ({
              returning: () => Promise.resolve(mockUpdateReturning),
            }),
          }),
        };
      },
    })),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  workflowExecutions: {
    id: "id",
    status: "status",
    dispatchKey: "dispatch_key",
  },
  workflows: { id: "id" },
}));

// The alias() self-join needs drizzle table internals the schema stub lacks.
vi.mock("drizzle-orm/pg-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm/pg-core")>();
  return {
    ...actual,
    alias: (_table: unknown, name: string) => ({
      id: `${name}.id`,
      status: `${name}.status`,
    }),
  };
});

vi.mock("@/lib/errors/finalize-error", () => ({
  recordExecutionErrorFinalized: vi.fn(),
}));
vi.mock("@/lib/metrics/collectors/prometheus", () => ({
  recordWorkflowExecutionFinished: vi.fn(),
}));
vi.mock("@/lib/metrics/org-slug.server", () => ({
  resolveOrgSlugForCounter: vi.fn(async () => "acme"),
}));

import { PATCH } from "@/app/api/internal/executions/[executionId]/route";
import { POST } from "@/app/api/internal/executions/route";

function postRequest(body: unknown): Request {
  return new Request("http://localhost:3000/api/internal/executions", {
    method: "POST",
    headers: {
      "X-Service-Key": "test-key",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function patchRequest(body: unknown): Request {
  return new Request("http://localhost:3000/api/internal/executions/exec_1", {
    method: "PATCH",
    headers: {
      "X-Service-Key": "test-key",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

const patchContext = {
  params: Promise.resolve({ executionId: "exec_1" }),
};

describe("POST /api/internal/executions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthResult.authenticated = true;
    mockWorkflow = {
      organizationId: "org_1",
      deletedAt: null,
      nodes: [],
      userId: "wf_owner",
    };
    insertedValues = null;
    mockInsertReturning = [{ id: "exec_created" }];
    mockSelectResult = [];
    enforceExecutionLimit.mockResolvedValue({ blocked: false });
    enforceWorkflowFeatures.mockResolvedValue({ blocked: false });
    checkDispatchAdmission.mockResolvedValue(null);
  });

  it("creates a running row by default and returns the execution id", async () => {
    const response = await POST(
      postRequest({ workflowId: "wf_1", userId: "user_1" })
    );
    const data = await response.json();

    expect(response.status).toBe(201);
    expect(data.executionId).toBe("exec_created");
    expect(insertedValues?.status).toBe("running");
    expect(insertedValues?.billable).toBe(true);
    expect(enforceExecutionLimit).toHaveBeenCalledTimes(1);
  });

  it("creates a phantom row and skips the running-row guards", async () => {
    const response = await POST(
      postRequest({ workflowId: "wf_1", userId: "user_1", status: "phantom" })
    );
    const data = await response.json();

    expect(response.status).toBe(201);
    expect(data.executionId).toBe("exec_created");
    expect(insertedValues?.status).toBe("phantom");
    // A phantom must not count toward billing until it actually runs.
    expect(insertedValues?.billable).toBe(false);
    // Quota is charged when the executor upgrades to running, not now.
    expect(enforceExecutionLimit).not.toHaveBeenCalled();
    expect(checkDispatchAdmission).toHaveBeenCalledTimes(1);
  });

  it("refuses a phantom the org may not run, without creating one", async () => {
    checkDispatchAdmission.mockResolvedValue({
      reason: "execution_limit",
      message: "limit reached",
    });

    const response = await POST(
      postRequest({
        workflowId: "wf_1",
        userId: "user_1",
        status: "phantom",
        triggerSource: "schedule",
      })
    );
    const data = await response.json();

    // 200, not an error status: a refusal must never look like a transport
    // failure, which the dispatchers fall back to enqueueing through.
    expect(response.status).toBe(200);
    expect(data).toMatchObject({
      refused: true,
      reason: "execution_limit",
      error: "limit reached",
    });
    expect(data.executionId).toBeUndefined();
    // 'skipped', not 'error': the run never executed, so it stays out of the
    // error count and the success-rate denominator.
    expect(insertedValues?.status).toBe("skipped");
  });

  it("records one visible row per workflow, reason and hour for refusals", async () => {
    checkDispatchAdmission.mockResolvedValue({
      reason: "plan_feature",
      message: "gated action",
    });

    await POST(
      postRequest({ workflowId: "wf_1", userId: "user_1", status: "phantom" })
    );

    // The hour-bucketed key is what the unique index collapses, so a fast
    // trigger writes one row an hour instead of one per occurrence.
    expect(insertedValues?.dispatchKey).toMatch(
      /^refused:wf_1:plan_feature:\d{4}-\d{2}-\d{2}T\d{2}$/
    );
    expect(insertedValues?.status).toBe("skipped");
    expect(insertedValues?.error).toBe("gated action");
    expect(insertedValues?.errorCategory).toBe("billing");
    expect(insertedValues?.errorType).toBe("user");
    // Refused before it started, so it consumes no quota.
    expect(insertedValues?.billable).toBe(false);
  });

  it("attributes the row to the supplied trigger source", async () => {
    await POST(
      postRequest({
        workflowId: "wf_1",
        userId: "user_1",
        status: "phantom",
        triggerSource: "block",
      })
    );

    expect(buildAttribution).toHaveBeenCalledWith(sourceArg("block"));
  });

  it("defaults an unknown trigger source to internal", async () => {
    await POST(
      postRequest({
        workflowId: "wf_1",
        userId: "user_1",
        triggerSource: "bogus",
      })
    );

    expect(buildAttribution).toHaveBeenCalledWith(sourceArg("internal"));
  });

  it("persists the dispatch key and returns alreadyExisted=false on create", async () => {
    const response = await POST(
      postRequest({
        workflowId: "wf_1",
        status: "phantom",
        triggerSource: "schedule",
        dispatchKey: "schedule:sched_1:2026-01-01T00:00:00.000Z",
      })
    );
    const data = await response.json();

    expect(response.status).toBe(201);
    expect(data.alreadyExisted).toBe(false);
    expect(insertedValues?.dispatchKey).toBe(
      "schedule:sched_1:2026-01-01T00:00:00.000Z"
    );
  });

  it("stores a null dispatch key when none is supplied", async () => {
    await POST(postRequest({ workflowId: "wf_1", status: "phantom" }));
    expect(insertedValues?.dispatchKey).toBeNull();
  });

  it("returns the existing row with alreadyExisted=true on a dispatch-key conflict", async () => {
    // Insert no-ops (conflict) -> returning is empty; the fallback lookup finds
    // the row the winning dispatcher already created.
    mockInsertReturning = [];
    mockSelectResult = [{ id: "exec_existing" }];

    const response = await POST(
      postRequest({
        workflowId: "wf_1",
        status: "phantom",
        triggerSource: "schedule",
        dispatchKey: "schedule:sched_1:2026-01-01T00:00:00.000Z",
      })
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.alreadyExisted).toBe(true);
    expect(data.executionId).toBe("exec_existing");
  });

  it("returns 500 if the insert conflicts but the row cannot be found", async () => {
    mockInsertReturning = [];
    mockSelectResult = [];

    const response = await POST(
      postRequest({
        workflowId: "wf_1",
        status: "phantom",
        dispatchKey: "schedule:sched_1:2026-01-01T00:00:00.000Z",
      })
    );

    expect(response.status).toBe(500);
  });

  it("returns 400 when workflowId is missing", async () => {
    const response = await POST(postRequest({ userId: "user_1" }));
    expect(response.status).toBe(400);
  });

  it("derives userId from the workflow when omitted (cron path)", async () => {
    const response = await POST(postRequest({ workflowId: "wf_1" }));

    expect(response.status).toBe(201);
    expect(insertedValues?.userId).toBe("wf_owner");
  });

  it("returns 404 for a soft-deleted workflow", async () => {
    mockWorkflow = {
      organizationId: "org_1",
      deletedAt: new Date(),
      nodes: [],
      userId: "wf_owner",
    };
    const response = await POST(
      postRequest({ workflowId: "wf_1", userId: "user_1" })
    );
    expect(response.status).toBe(404);
  });

  it("returns 401 when not authenticated", async () => {
    mockAuthResult.authenticated = false;
    const response = await POST(
      postRequest({ workflowId: "wf_1", userId: "user_1" })
    );
    expect(response.status).toBe(401);
  });
});

describe("PATCH /api/internal/executions/[executionId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthResult.authenticated = true;
    mockExistingExecution = { id: "exec_1", status: "phantom" };
    updatedSet = null;
    mockUpdateReturning = [];
  });

  it("writes a valid error code and derives type/category from the registry", async () => {
    const response = await PATCH(
      patchRequest({ status: "error", error: "boom", errorCode: "BS-0001" }),
      patchContext
    );

    expect(response.status).toBe(200);
    expect(updatedSet?.status).toBe("error");
    expect(updatedSet?.errorCode).toBe("BS-0001");
    expect(updatedSet?.errorType).toBe("system");
    // BS-0001 is classified workflow_engine in the registry.
    expect(updatedSet?.errorCategory).toBe("workflow_engine");
  });

  it("rejects an unknown error code with 400", async () => {
    const response = await PATCH(
      patchRequest({ status: "error", error: "boom", errorCode: "Z-9999" }),
      patchContext
    );
    expect(response.status).toBe(400);
  });

  it("accepts an error without a code (no code fields written)", async () => {
    const response = await PATCH(
      patchRequest({ status: "error", error: "boom" }),
      patchContext
    );

    expect(response.status).toBe(200);
    expect(updatedSet?.error).toBe("boom");
    expect(updatedSet?.errorCode).toBeUndefined();
  });

  it("does not attach a code on a success transition", async () => {
    const response = await PATCH(
      patchRequest({ status: "success" }),
      patchContext
    );

    expect(response.status).toBe(200);
    expect(updatedSet?.errorCode).toBeUndefined();
  });

  it("rejects an invalid status with 400", async () => {
    const response = await PATCH(
      patchRequest({ status: "phantom" }),
      patchContext
    );
    expect(response.status).toBe(400);
  });

  it("emits the error counters when a phantom row is first finalized as system_error", async () => {
    mockUpdateReturning = [{ workflowId: "wf_1", previousStatus: "phantom" }];
    const { recordExecutionErrorFinalized } = await import(
      "@/lib/errors/finalize-error"
    );

    const response = await PATCH(
      patchRequest({ status: "system_error", error: "enqueue failed" }),
      patchContext
    );

    expect(response.status).toBe(200);
    expect(recordExecutionErrorFinalized).toHaveBeenCalledWith({
      workflowId: "wf_1",
      errorMessage: "enqueue failed",
      persistedStatus: "system_error",
      errorCategory: "infrastructure",
    });
  });

  it("emits the finished counter on a first success transition", async () => {
    mockUpdateReturning = [{ workflowId: "wf_1", previousStatus: "running" }];
    const prometheusMod = await import("@/lib/metrics/collectors/prometheus");

    const response = await PATCH(
      patchRequest({ status: "success" }),
      patchContext
    );

    expect(response.status).toBe(200);
    expect(prometheusMod.recordWorkflowExecutionFinished).toHaveBeenCalledWith({
      status: "success",
      orgSlug: "acme",
      errorType: "na",
    });
  });

  it("emits nothing when re-finalizing an already-terminal row", async () => {
    mockUpdateReturning = [
      { workflowId: "wf_1", previousStatus: "system_error" },
    ];
    const { recordExecutionErrorFinalized } = await import(
      "@/lib/errors/finalize-error"
    );
    const prometheusMod = await import("@/lib/metrics/collectors/prometheus");

    const response = await PATCH(
      patchRequest({ status: "success" }),
      patchContext
    );

    expect(response.status).toBe(200);
    expect(recordExecutionErrorFinalized).not.toHaveBeenCalled();
    expect(
      prometheusMod.recordWorkflowExecutionFinished
    ).not.toHaveBeenCalled();
  });
});
