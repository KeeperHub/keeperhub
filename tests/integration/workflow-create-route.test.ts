import { beforeEach, describe, expect, it, vi } from "vitest";

// The route records a workflow snapshot, pulling in history -> version-diff ->
// step-registry, which `import "server-only"`. Stub the guard for vitest.
vi.mock("server-only", () => ({}));

const {
  mockGetDualAuthContext,
  mockInsert,
  mockValidateWorkflowIntegrations,
  mockSyncPersistedSchedule,
} = vi.hoisted(() => ({
  mockGetDualAuthContext: vi.fn(),
  mockInsert: vi.fn(),
  mockValidateWorkflowIntegrations: vi.fn(),
  mockSyncPersistedSchedule: vi.fn(),
}));

vi.mock("@/lib/middleware/auth-helpers", () => ({
  getDualAuthContext: mockGetDualAuthContext,
}));

vi.mock("@/lib/db", () => ({
  db: {
    insert: mockInsert,
  },
}));

vi.mock("@/lib/db/schema", () => ({
  projects: { id: "id", organizationId: "organization_id" },
  tags: { id: "id", organizationId: "organization_id" },
  workflows: {},
}));

vi.mock("@/lib/db/integrations", () => ({
  validateWorkflowIntegrations: mockValidateWorkflowIntegrations,
}));

vi.mock("@/lib/features/route-guard", () => ({
  enforceWorkflowFeatures: vi.fn().mockResolvedValue({ blocked: false }),
  FEATURE_UPGRADE_REQUIRED_ERROR:
    "This workflow uses features that require a paid plan.",
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { DATABASE: "DATABASE" },
  logSystemError: vi.fn(),
}));

// Idempotency wraps the route but is covered by its own unit tests. Stub it to
// a pass-through so this suite stays focused on create logic and does not pull
// in lib/idempotency's `server-only` import at collection time.
vi.mock("@/lib/idempotency", () => ({
  beginIdempotentFromRequest: vi.fn().mockResolvedValue(null),
  idempotencyEarlyResponse: vi.fn().mockReturnValue(null),
  recordIdempotentResponse: vi.fn((_idem, response) => response),
}));

// extractScheduleConfig runs for real so the interval pre-check exercises the
// actual cron-utils guard; only the write side effect is stubbed.
vi.mock("@/lib/schedule-service", async () => {
  const actual = await vi.importActual<typeof import("@/lib/schedule-service")>(
    "@/lib/schedule-service"
  );
  return {
    ...actual,
    syncPersistedWorkflowSchedule: mockSyncPersistedSchedule,
  };
});

vi.mock("@/lib/metrics/collectors/prometheus", () => ({
  recordWorkflowCreatedFromSource: vi.fn(),
}));

vi.mock("@/lib/workflow/history", () => ({
  recordWorkflowSnapshot: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/security/audit-log", () => ({
  buildAuditMetadata: vi.fn().mockReturnValue({}),
  recordAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

import { POST } from "@/app/api/workflows/create/route";

function request(body: Record<string, unknown>): Request {
  return new Request("http://localhost:3000/api/workflows/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function workflowBody(nodes: unknown[]) {
  return {
    name: "Invalid workflow",
    nodes,
    edges: [],
  };
}

function baseActionNode(config: Record<string, unknown>) {
  return {
    id: "node-1",
    type: "action",
    data: {
      type: "action",
      config,
    },
  };
}

describe("POST /api/workflows/create action config validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDualAuthContext.mockResolvedValue({
      userId: "user-123",
      organizationId: "org-123",
      authMethod: "session",
    });
    mockValidateWorkflowIntegrations.mockResolvedValue({ valid: true });
  });

  it("rejects invalid action config before inserting workflow", async () => {
    const response = await POST(
      request(
        workflowBody([
          baseActionNode({
            actionType: "discord/send-message",
            Message: "hello",
          }),
        ])
      )
    );

    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.error).toBe("INVALID_ACTION_CONFIG");
    expect(body.invalidFields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "UNKNOWN_FIELD", field: "Message" }),
        expect.objectContaining({
          code: "MISSING_REQUIRED_FIELD",
          field: "discordMessage",
        }),
      ])
    );
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("rejects unknown action types before inserting workflow", async () => {
    const response = await POST(
      request(
        workflowBody([
          baseActionNode({
            actionType: "webhook/send",
            webhookUrl: "https://example.com",
          }),
        ])
      )
    );

    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.invalidFields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "UNKNOWN_ACTION_TYPE" }),
      ])
    );
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("rejects invalid typed protocol fields before inserting workflow", async () => {
    const response = await POST(
      request(
        workflowBody([
          baseActionNode({
            actionType: "aave-v3/supply",
            network: "1",
            asset: "not-an-address",
            amount: "1000000000000000000",
            onBehalfOf: "0x0000000000000000000000000000000000000001",
          }),
        ])
      )
    );

    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.invalidFields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "INVALID_FIELD_TYPE",
          field: "asset",
        }),
      ])
    );
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("validates integration ownership after sanitizer moves misplaced config fields", async () => {
    mockValidateWorkflowIntegrations.mockResolvedValue({
      valid: false,
      invalidIds: ["foreign-integration"],
    });

    const response = await POST(
      request(
        workflowBody([
          {
            id: "node-1",
            type: "action",
            data: {
              type: "action",
              actionType: "discord/send-message",
              integrationId: "foreign-integration",
              discordMessage: "hello",
            },
          },
        ])
      )
    );

    expect(response.status).toBe(403);
    expect(mockValidateWorkflowIntegrations).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          data: expect.objectContaining({
            config: expect.objectContaining({
              integrationId: "foreign-integration",
            }),
          }),
        }),
      ],
      "org-123"
    );
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("accepts a Hub draft payload (actionType + _protocolMeta only) and proceeds to insert", async () => {
    const mockReturning = vi.fn().mockResolvedValue([
      {
        id: "wf-1",
        name: "Untitled Workflow",
        enabled: false,
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
      },
    ]);
    mockInsert.mockReturnValue({
      values: vi.fn().mockReturnValue({ returning: mockReturning }),
    });

    const protocolMeta = JSON.stringify({
      protocolSlug: "aave-v3",
      contractKey: "pool",
      functionName: "supply",
      actionType: "write",
    });

    const response = await POST(
      request(
        workflowBody([
          baseActionNode({
            actionType: "aave-v3/supply",
            _protocolMeta: protocolMeta,
          }),
        ])
      )
    );

    expect(response.status).not.toBe(422);
    expect(mockInsert).toHaveBeenCalled();
  });
});

describe("POST /api/workflows/create schedule registration", () => {
  function scheduleTrigger(
    config: Record<string, unknown>
  ): Record<string, unknown> {
    return {
      id: "trigger-1",
      type: "trigger",
      data: {
        type: "trigger",
        label: "Schedule",
        config: { triggerType: "Schedule", ...config },
      },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDualAuthContext.mockResolvedValue({
      userId: "user-123",
      organizationId: "org-123",
      authMethod: "session",
    });
    mockValidateWorkflowIntegrations.mockResolvedValue({ valid: true });
    mockSyncPersistedSchedule.mockResolvedValue(undefined);
    mockInsert.mockReturnValue({
      values: vi.fn((row: Record<string, unknown>) => ({
        returning: vi
          .fn()
          .mockResolvedValue([
            { ...row, createdAt: new Date(), updatedAt: new Date() },
          ]),
      })),
    });
  });

  it("registers the schedule so the dispatcher sees the new workflow", async () => {
    const response = await POST(
      request({
        name: "Hourly check",
        nodes: [
          scheduleTrigger({
            scheduleCron: "0 * * * *",
            scheduleTimezone: "UTC",
          }),
        ],
        edges: [],
        enabled: true,
      })
    );

    expect(response.status).toBe(200);
    expect(mockSyncPersistedSchedule).toHaveBeenCalledTimes(1);
    const [workflowId, nodes] = mockSyncPersistedSchedule.mock.calls[0];
    const created = await response.json();
    expect(workflowId).toBe(created.id);
    expect(nodes[0].data.config.scheduleCron).toBe("0 * * * *");
  });

  it("rejects a sub-minimum interval before inserting the workflow", async () => {
    const response = await POST(
      request({
        name: "Too fast",
        nodes: [scheduleTrigger({ scheduleIntervalSeconds: 30 })],
        edges: [],
      })
    );

    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("SCHEDULE_INTERVAL_TOO_SMALL");
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockSyncPersistedSchedule).not.toHaveBeenCalled();
  });
});
