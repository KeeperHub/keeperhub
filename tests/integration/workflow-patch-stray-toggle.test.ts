// PATCH /api/workflows/[workflowId] compares toggles with the stored workflow:
// a stray value kept as it was saved still saves, a new or changed one does
// not. Without this, one old stray value would block every save.

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

const TEMPLATE = "{{@webhook:Webhook.flag}}";

function httpNode(failOnError: unknown): Record<string, unknown> {
  return {
    id: "http-1",
    type: "action",
    position: { x: 0, y: 0 },
    data: {
      type: "action",
      label: "Fetch",
      config: {
        actionType: "HTTP Request",
        endpoint: "https://example.com",
        httpMethod: "GET",
        failOnError,
      },
    },
  };
}

function existingWorkflow(nodes: unknown[]): Record<string, unknown> {
  return {
    id: "wf-1",
    userId: "user-1",
    organizationId: "org-1",
    name: "wf",
    description: "",
    nodes,
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

describe("PATCH /api/workflows/[workflowId] with a stray toggle value", () => {
  function storedWith(failOnError: unknown): void {
    const stored = existingWorkflow([httpNode(failOnError)]);
    mockWorkflowsFindFirst.mockResolvedValue(stored);
    mockUpdateReturning.mockResolvedValue([stored]);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDualAuthContext.mockResolvedValue({
      userId: "user-1",
      organizationId: "org-1",
      authMethod: "session",
    });
    mockValidateWorkflowIntegrations.mockResolvedValue({ valid: true });
    mockSelectFrom.mockResolvedValue([]);
    mockMemberLimit.mockResolvedValue([{ id: "m-1" }]);
    mockSyncWorkflowSchedule.mockResolvedValue({ synced: true });
  });

  it("saves while the stored value is unchanged", async () => {
    storedWith(TEMPLATE);
    const response = await PATCH(makeRequest({ nodes: [httpNode(TEMPLATE)] }), {
      params,
    });
    expect(response.status).toBe(200);
  });

  it("compares with a stored node in the old shape, toggle at the data root", async () => {
    const node = httpNode(TEMPLATE) as {
      data: { config: Record<string, unknown> } & Record<string, unknown>;
    };
    const { failOnError, ...config } = node.data.config;
    const stored = existingWorkflow([
      { ...node, data: { ...node.data, config, failOnError } },
    ]);
    mockWorkflowsFindFirst.mockResolvedValue(stored);
    mockUpdateReturning.mockResolvedValue([stored]);
    const response = await PATCH(makeRequest({ nodes: [httpNode(TEMPLATE)] }), {
      params,
    });
    expect(response.status).toBe(200);
  });

  it("refuses a changed value", async () => {
    storedWith(TEMPLATE);
    const response = await PATCH(
      makeRequest({ nodes: [httpNode("{{@webhook:Webhook.other}}")] }),
      { params }
    );
    expect(response.status).toBe(422);
    expect((await response.json()).error).toBe("INVALID_ACTION_CONFIG");
    expect(mockUpdateReturning).not.toHaveBeenCalled();
  });

  it("refuses a new value", async () => {
    storedWith(true);
    const response = await PATCH(makeRequest({ nodes: [httpNode(TEMPLATE)] }), {
      params,
    });
    expect(response.status).toBe(422);
  });
});
