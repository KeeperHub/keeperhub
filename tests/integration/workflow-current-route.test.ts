import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetSession,
  mockGetOrgContext,
  mockValidateWorkflowIntegrations,
  mockSelect,
} = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockGetOrgContext: vi.fn(),
  mockValidateWorkflowIntegrations: vi.fn(),
  mockSelect: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: {
    api: {
      getSession: mockGetSession,
    },
  },
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: mockSelect,
    update: vi.fn(),
    insert: vi.fn(),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  workflows: {
    id: "id",
    name: "name",
    userId: "user_id",
    updatedAt: "updated_at",
  },
}));

vi.mock("@/lib/db/integrations", () => ({
  validateWorkflowIntegrations: mockValidateWorkflowIntegrations,
}));

vi.mock("@/lib/features/route-guard", () => ({
  enforceWorkflowFeatures: vi.fn().mockResolvedValue({ blocked: false }),
  FEATURE_UPGRADE_REQUIRED_ERROR:
    "This workflow uses features that require a paid plan.",
}));

vi.mock("@/lib/middleware/org-context", () => ({
  getOrgContext: mockGetOrgContext,
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { DATABASE: "DATABASE" },
  logSystemError: vi.fn(),
}));

import { POST } from "@/app/api/workflows/current/route";

function request(nodes: unknown[]): Request {
  return new Request("http://localhost:3000/api/workflows/current", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nodes, edges: [] }),
  });
}

describe("POST /api/workflows/current action config validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({
      user: { id: "user-123", email: "user@example.com" },
    });
    mockGetOrgContext.mockResolvedValue({
      organization: { id: "org-123" },
    });
    mockValidateWorkflowIntegrations.mockResolvedValue({ valid: true });
  });

  it("rejects invalid action config before autosaving current workflow", async () => {
    const response = await POST(
      request([
        {
          id: "node-1",
          type: "action",
          data: {
            type: "action",
            config: {
              actionType: "discord/send-message",
              Message: "hello",
            },
          },
        },
      ])
    );

    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.error).toBe("INVALID_ACTION_CONFIG");
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it("validates integration ownership after sanitizer moves misplaced config fields", async () => {
    mockValidateWorkflowIntegrations.mockResolvedValue({
      valid: false,
      invalidIds: ["foreign-integration"],
    });

    const response = await POST(
      request([
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
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it("rejects with 409 when there is no active org", async () => {
    mockGetOrgContext.mockResolvedValue({ organization: null });

    const response = await POST(
      request([
        {
          id: "node-1",
          type: "action",
          data: {
            type: "action",
            config: {
              actionType: "discord/send-message",
              integrationId: "foreign-integration",
              discordMessage: "hello",
            },
          },
        },
      ])
    );

    expect(response.status).toBe(409);
    expect(mockValidateWorkflowIntegrations).not.toHaveBeenCalled();
  });
});
