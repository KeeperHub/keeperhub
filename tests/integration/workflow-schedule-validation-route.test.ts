// KEEP-581: pre-save schedule-interval validation on PATCH
// /api/workflows/[workflowId]. The route now runs extractScheduleConfig
// against body.nodes before the DB update so sub-60s intervals never
// land as persisted nodes paired with a missing or miscadenced schedule
// row. Other sync failures (bad timezone, invalid cron) still take the
// warn-and-continue path inside handlePostUpdateSideEffects.

import { beforeEach, describe, expect, it, vi } from "vitest";

// The route records a workflow snapshot, pulling in history -> version-diff ->
// step-registry, which `import "server-only"`. Stub the guard for vitest.
vi.mock("server-only", () => ({}));

const {
  mockGetDualAuthContext,
  mockWorkflowsFindFirst,
  mockUpdateReturning,
  mockSelectFrom,
  mockMemberLimit,
  mockValidateWorkflowIntegrations,
  mockSyncWorkflowSchedule,
} = vi.hoisted(() => ({
  mockGetDualAuthContext: vi.fn(),
  mockWorkflowsFindFirst: vi.fn(),
  mockUpdateReturning: vi.fn(),
  mockSelectFrom: vi.fn(),
  mockMemberLimit: vi.fn(),
  mockValidateWorkflowIntegrations: vi.fn(),
  mockSyncWorkflowSchedule: vi.fn(),
}));

vi.mock("@/lib/middleware/auth-helpers", () => ({
  getDualAuthContext: mockGetDualAuthContext,
}));

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      workflows: {
        findFirst: mockWorkflowsFindFirst,
      },
    },
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: mockUpdateReturning,
        })),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn().mockResolvedValue(undefined),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          where: vi.fn((...args) => {
            const p = mockSelectFrom(...args);
            return Object.assign(p, { limit: mockMemberLimit });
          }),
        })),
        where: vi.fn(() => ({
          limit: mockMemberLimit,
        })),
      })),
    })),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  workflows: { id: "id" },
  workflowPublicTags: {
    workflowId: "workflow_id",
    publicTagId: "public_tag_id",
  },
  publicTags: { id: "id", name: "name", slug: "slug" },
  member: { id: "id", organizationId: "organization_id", userId: "user_id" },
  users: { id: "id", deactivatedAt: "deactivated_at" },
  projects: { id: "id", organizationId: "organization_id" },
  tags: { id: "id", organizationId: "organization_id" },
  workflowExecutions: { workflowId: "workflow_id" },
  workflowSchedules: { workflowId: "workflow_id" },
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { DATABASE: "DATABASE" },
  logSystemError: vi.fn(),
}));

vi.mock("@/lib/db/integrations", () => ({
  validateWorkflowIntegrations: mockValidateWorkflowIntegrations,
}));

vi.mock("@/lib/features/route-guard", () => ({
  enforceWorkflowFeatures: vi.fn().mockResolvedValue({ blocked: false }),
  FEATURE_UPGRADE_REQUIRED_ERROR:
    "This workflow uses features that require a paid plan.",
}));

// Only the side-effect sync is mocked; extractScheduleConfig is exercised
// for real so the pre-check path runs the actual parseIntervalSeconds
// guard from cron-utils.
vi.mock("@/lib/schedule-service", async () => {
  const actual = await vi.importActual<typeof import("@/lib/schedule-service")>(
    "@/lib/schedule-service"
  );
  return {
    ...actual,
    syncPersistedWorkflowSchedule: mockSyncWorkflowSchedule,
  };
});

vi.mock("@/lib/sanitize-description", () => ({
  sanitizeDescription: vi.fn((raw: string) => `SANITIZED:${raw}`),
}));

vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
}));

import { PATCH } from "@/app/api/workflows/[workflowId]/route";

function makeRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost:3000/api/workflows/wf-1", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const params = Promise.resolve({ workflowId: "wf-1" });

function scheduleTriggerNode(
  scheduleIntervalSeconds: number | string | null
): Record<string, unknown> {
  return {
    id: "trigger-1",
    type: "trigger",
    position: { x: 0, y: 0 },
    data: {
      type: "trigger",
      label: "Schedule",
      config: {
        triggerType: "Schedule",
        scheduleIntervalSeconds,
        scheduleTimezone: "UTC",
        scheduleCron: "0 9 * * *",
      },
    },
  };
}

function existingWorkflow(): Record<string, unknown> {
  return {
    id: "wf-1",
    userId: "user-1",
    organizationId: "org-1",
    name: "wf",
    description: "",
    nodes: [],
    edges: [],
    visibility: "private",
    isAnonymous: false,
    enabled: true,
    projectId: null,
    tagId: null,
    isListed: false,
    listedSlug: null,
    listedAt: null,
    inputSchema: null,
    outputMapping: null,
    priceUsdcPerCall: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  };
}

describe("KEEP-581: PATCH /api/workflows/[workflowId] schedule interval guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDualAuthContext.mockResolvedValue({
      userId: "user-1",
      organizationId: "org-1",
      authMethod: "session",
    });
    mockValidateWorkflowIntegrations.mockResolvedValue({ valid: true });
    mockWorkflowsFindFirst.mockResolvedValue(existingWorkflow());
    mockSelectFrom.mockResolvedValue([]);
    mockMemberLimit.mockResolvedValue([{ id: "m-1" }]);
    mockSyncWorkflowSchedule.mockResolvedValue({ synced: true });
    mockUpdateReturning.mockResolvedValue([existingWorkflow()]);
  });

  it("returns 400 with SCHEDULE_INTERVAL_TOO_SMALL when scheduleIntervalSeconds is 30", async () => {
    const response = await PATCH(
      makeRequest({ nodes: [scheduleTriggerNode(30)] }),
      { params }
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("SCHEDULE_INTERVAL_TOO_SMALL");
    expect(body.message).toContain(">= 60");
  });

  it("returns 400 at the boundary just below the floor (59)", async () => {
    const response = await PATCH(
      makeRequest({ nodes: [scheduleTriggerNode(59)] }),
      { params }
    );

    expect(response.status).toBe(400);
  });

  it("does not call syncWorkflowSchedule when the pre-check rejects (no partial write)", async () => {
    await PATCH(makeRequest({ nodes: [scheduleTriggerNode(15)] }), { params });

    expect(mockSyncWorkflowSchedule).not.toHaveBeenCalled();
    expect(mockUpdateReturning).not.toHaveBeenCalled();
  });

  it("accepts scheduleIntervalSeconds at the exact floor (60)", async () => {
    const response = await PATCH(
      makeRequest({ nodes: [scheduleTriggerNode(60)] }),
      { params }
    );

    expect(response.status).toBe(200);
    expect(mockSyncWorkflowSchedule).toHaveBeenCalledTimes(1);
  });

  it("accepts a workflow with no schedule trigger (manual)", async () => {
    const manualTrigger = {
      id: "trigger-1",
      type: "trigger",
      position: { x: 0, y: 0 },
      data: {
        type: "trigger",
        label: "Manual",
        config: { triggerType: "Manual" },
      },
    };

    const response = await PATCH(makeRequest({ nodes: [manualTrigger] }), {
      params,
    });

    expect(response.status).toBe(200);
  });
});

describe("PATCH /api/workflows/[workflowId] schedule registration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDualAuthContext.mockResolvedValue({
      userId: "user-1",
      organizationId: "org-1",
      authMethod: "session",
    });
    mockValidateWorkflowIntegrations.mockResolvedValue({ valid: true });
    mockWorkflowsFindFirst.mockResolvedValue({
      ...existingWorkflow(),
      enabled: false,
    });
    mockSelectFrom.mockResolvedValue([]);
    mockMemberLimit.mockResolvedValue([{ id: "m-1" }]);
    mockSyncWorkflowSchedule.mockResolvedValue(undefined);
    mockUpdateReturning.mockResolvedValue([
      { ...existingWorkflow(), nodes: [scheduleTriggerNode(null)] },
    ]);
  });

  it("registers the schedule on an enable-only PATCH", async () => {
    const response = await PATCH(makeRequest({ enabled: true }), { params });

    expect(response.status).toBe(200);
    expect(mockSyncWorkflowSchedule).toHaveBeenCalledTimes(1);
    expect(mockSyncWorkflowSchedule).toHaveBeenCalledWith(
      "wf-1",
      [scheduleTriggerNode(null)],
      expect.any(String)
    );
  });

  it("syncs the persisted nodes rather than the raw request body", async () => {
    // A trigger in the MCP shape the sanitizer canonicalises. Syncing the raw
    // body would not see a Schedule trigger at all.
    const rawTrigger = {
      id: "trigger-1",
      type: "Schedule",
      data: { scheduleCron: "0 9 * * *", scheduleTimezone: "UTC" },
    };

    await PATCH(makeRequest({ nodes: [rawTrigger] }), { params });

    expect(mockSyncWorkflowSchedule).toHaveBeenCalledWith(
      "wf-1",
      [scheduleTriggerNode(null)],
      expect.any(String)
    );
  });

  it("does not touch the schedule when neither nodes nor enable change", async () => {
    const response = await PATCH(makeRequest({ name: "renamed" }), { params });

    expect(response.status).toBe(200);
    expect(mockSyncWorkflowSchedule).not.toHaveBeenCalled();
  });

  it("does not re-register on a disable", async () => {
    mockWorkflowsFindFirst.mockResolvedValue(existingWorkflow());

    await PATCH(makeRequest({ enabled: false }), { params });

    expect(mockSyncWorkflowSchedule).not.toHaveBeenCalled();
  });
});
