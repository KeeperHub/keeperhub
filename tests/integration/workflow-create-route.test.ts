import { beforeEach, describe, expect, it, vi } from "vitest";

// The route records a workflow snapshot, pulling in history -> version-diff ->
// step-registry, which `import "server-only"`. Stub the guard for vitest.
vi.mock("server-only", () => ({}));

const { mockGetDualAuthContext, mockInsert, mockValidateWorkflowIntegrations } =
  vi.hoisted(() => ({
    mockGetDualAuthContext: vi.fn(),
    mockInsert: vi.fn(),
    mockValidateWorkflowIntegrations: vi.fn(),
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

  // Regression coverage for #2011's CHANGES_REQUESTED: create must NOT
  // auto-flip workflowType to "write", even when the payload has a
  // write-contract node. Doing so used to plant an ungated "write" value
  // into deriveWorkflowType's up-only ratchet -- PATCH always re-derives
  // from the row's *current* workflowType, so a later edit removing the
  // write node could never fall the row back to "read", and listing it
  // afterward failed MISSING_WRITE_ACTION even though the workflow was
  // never actually verified write-capable. This route never sets
  // `isListed`, so a freshly created row can never be a listing candidate
  // (the `willBeListed` condition the PATCH handler gates its own flip on)
  // -- mirroring that reasoning here means create always stays "read" and
  // lets the first real content-changing PATCH, or the listing action
  // itself, derive "write" once it's actually gated.
  it('keeps workflowType "read" on create even with a write-contract node', async () => {
    const mockReturning = vi.fn().mockResolvedValue([
      {
        id: "wf-1",
        name: "Untitled Workflow",
        enabled: false,
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
      },
    ]);
    const mockValues = vi.fn().mockReturnValue({ returning: mockReturning });
    mockInsert.mockReturnValue({ values: mockValues });

    const response = await POST(
      request(
        workflowBody([
          baseActionNode({
            actionType: "web3/write-contract",
            network: "1",
            contractAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
            abi: JSON.stringify([
              {
                inputs: [],
                name: "doWrite",
                outputs: [],
                stateMutability: "nonpayable",
                type: "function",
              },
            ]),
            abiFunction: "doWrite",
            functionArgs: "[]",
          }),
        ])
      )
    );

    expect(response.status).not.toBe(422);
    expect(mockValues).toHaveBeenCalledWith(
      expect.objectContaining({ workflowType: "read" })
    );
  });

  it('keeps workflowType "read" on create with no write-action node', async () => {
    const mockReturning = vi.fn().mockResolvedValue([
      {
        id: "wf-2",
        name: "Untitled Workflow",
        enabled: false,
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
      },
    ]);
    const mockValues = vi.fn().mockReturnValue({ returning: mockReturning });
    mockInsert.mockReturnValue({ values: mockValues });

    const response = await POST(
      request(
        workflowBody([
          baseActionNode({
            actionType: "discord/send-message",
            discordMessage: "hello",
          }),
        ])
      )
    );

    expect(response.status).not.toBe(422);
    expect(mockValues).toHaveBeenCalledWith(
      expect.objectContaining({ workflowType: "read" })
    );
  });
});
