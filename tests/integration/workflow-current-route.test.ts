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
import { db } from "@/lib/db";

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

describe("POST /api/workflows/current Web3 Connection", () => {
  const TARGET = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
  const mockValues = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({
      user: { id: "user-123", email: "user@example.com" },
    });
    mockGetOrgContext.mockResolvedValue({
      organization: { id: "org-123" },
    });
    mockValidateWorkflowIntegrations.mockResolvedValue({ valid: true });
    // No current workflow yet, so the route inserts one.
    mockSelect.mockReturnValue({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
    });
    mockValues.mockImplementation((row: Record<string, unknown>) => ({
      returning: () => Promise.resolve([{ id: "wf-1", ...row }]),
    }));
    vi.mocked(db.insert).mockReturnValue({
      values: mockValues,
    } as unknown as ReturnType<typeof db.insert>);
  });

  function step(config: Record<string, unknown>): Record<string, unknown> {
    return {
      id: "node-1",
      type: "action",
      data: { type: "action", config },
    };
  }

  function storedConfig(): Record<string, unknown> {
    const { nodes } = mockValues.mock.calls[0][0] as {
      nodes: { data: { config: Record<string, unknown> } }[];
    };
    return nodes[0].data.config;
  }

  it("keeps one picked on a Write Contract step", async () => {
    const response = await POST(
      request([
        step({
          actionType: "web3/write-contract",
          network: "1",
          contractAddress: TARGET,
          abi: JSON.stringify([
            {
              inputs: [],
              name: "run",
              outputs: [],
              stateMutability: "nonpayable",
              type: "function",
            },
          ]),
          abiFunction: "run",
          web3Connection: "safe:safe-1",
        }),
      ])
    );
    expect(response.status).toBe(200);
    expect(storedConfig().web3Connection).toBe("safe:safe-1");
  });

  const AAVE = {
    actionType: "aave-v3/supply",
    network: "1",
    asset: TARGET,
    amount: "1",
    onBehalfOf: TARGET,
  };

  it("drops a new one on an Aave step, which would ignore it", async () => {
    // Only an editor session reaches this route, so it is stripped, not refused.
    const response = await POST(
      request([step({ ...AAVE, web3Connection: "safe:safe-1" })])
    );
    expect(response.status).toBe(200);
    expect(storedConfig()).not.toHaveProperty("web3Connection");
  });

  it("drops one the stored draft already holds on an Aave step", async () => {
    const mockSet = vi.fn((row: Record<string, unknown>) => ({
      where: () => ({
        returning: () => Promise.resolve([{ id: "wf-1", ...row }]),
      }),
    }));
    mockSelect.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: () =>
            Promise.resolve([
              {
                id: "wf-1",
                nodes: [step({ ...AAVE, web3Connection: "safe:safe-1" })],
              },
            ]),
        }),
      }),
    });
    vi.mocked(db.update).mockReturnValue({
      set: mockSet,
    } as unknown as ReturnType<typeof db.update>);

    const response = await POST(
      request([step({ ...AAVE, web3Connection: "safe:safe-1" })])
    );
    expect(response.status).toBe(200);
    const { nodes } = mockSet.mock.calls[0][0] as {
      nodes: { data: { config: Record<string, unknown> } }[];
    };
    expect(nodes[0].data.config).not.toHaveProperty("web3Connection");
  });
});
