import { beforeEach, describe, expect, it, vi } from "vitest";

// The route records a workflow snapshot, pulling in history -> version-diff ->
// step-registry, which `import "server-only"`. Stub the guard for vitest.
vi.mock("server-only", () => ({}));

const {
  mockGetDualAuthContext,
  mockWorkflowsFindFirst,
  mockUpdateReturning,
  mockMemberLimit,
  mockSelectFrom,
  mockValidateWorkflowIntegrations,
  capturedSet,
} = vi.hoisted(() => ({
  mockGetDualAuthContext: vi.fn(),
  mockWorkflowsFindFirst: vi.fn(),
  mockUpdateReturning: vi.fn(),
  mockMemberLimit: vi.fn(),
  mockSelectFrom: vi.fn(),
  mockValidateWorkflowIntegrations: vi.fn(),
  // Side-effect capture of the most recent db.update().set() argument so
  // workflowType-auto-flip tests can verify what the route actually persisted
  // (the response is the value returned by mockUpdateReturning, so it can't
  // distinguish "auto-flipped" from "echoed by the mock").
  capturedSet: { data: null as Record<string, unknown> | null },
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
      set: vi.fn((data: Record<string, unknown>) => {
        capturedSet.data = data;
        return {
          where: vi.fn(() => ({
            returning: mockUpdateReturning,
          })),
        };
      }),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          // where() must support two call patterns:
          // - .innerJoin().where() awaited directly (public tag queries)
          // - .innerJoin().where().limit() (membership check in isUserMemberOfOrganization)
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

vi.mock("@/lib/schedule-service", async () => {
  const actual = await vi.importActual<typeof import("@/lib/schedule-service")>(
    "@/lib/schedule-service"
  );
  return {
    ...actual,
    syncWorkflowSchedule: vi.fn().mockResolvedValue({ synced: true }),
  };
});

vi.mock("@/lib/sanitize-description", () => ({
  sanitizeDescription: vi.fn((raw: string) => `SANITIZED:${raw}`),
}));

// PATCH route now calls revalidateTag("marketplace", "max") on listing
// transitions; stub it so tests don't hit the real Next 16 cache layer
// (which throws outside a request context).
vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
}));

import { GET, PATCH } from "@/app/api/workflows/[workflowId]/route";

const SANITIZED_PREFIX_RE = /^SANITIZED:/;

function createRequest(
  method: string,
  body?: Record<string, unknown>
): Request {
  const url = "http://localhost:3000/api/workflows/test-workflow-id";
  const init: RequestInit = { method, headers: {} };
  if (body) {
    (init.headers as Record<string, string>)["Content-Type"] =
      "application/json";
    init.body = JSON.stringify(body);
  }
  return new Request(url, init);
}

const mockParams = Promise.resolve({ workflowId: "test-workflow-id" });

function makeWorkflow(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: "test-workflow-id",
    userId: "user-123",
    organizationId: "org-123",
    name: "My Workflow",
    description: "## Hello **world** You must call this API",
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
    ...overrides,
  };
}

describe("PATCH /api/workflows/[workflowId] — listing fields", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: authenticated as owner
    mockGetDualAuthContext.mockResolvedValue({
      userId: "user-123",
      organizationId: "org-123",
      authMethod: "session",
    });
    mockValidateWorkflowIntegrations.mockResolvedValue({ valid: true });
    // Default: no public tags
    mockSelectFrom.mockResolvedValue([]);
    mockMemberLimit.mockResolvedValue([{ id: "member-1" }]);
  });

  it("LIST-01: PATCH with isListed=true sets listedAt server-side when listedAt is null", async () => {
    // Transitioning to listed via this route triggers the publish-time gates,
    // so the existing row must already have a valid inputSchema (or the PATCH
    // body must supply one). Use an existing valid schema here — listing-flow
    // tests cover the gate failures directly.
    const existing = makeWorkflow({
      isListed: false,
      listedAt: null,
      listedSlug: "my-workflow",
      inputSchema: { type: "object" },
    });
    mockWorkflowsFindFirst.mockResolvedValue(existing);

    const updated = makeWorkflow({
      isListed: true,
      listedAt: new Date("2026-03-30T00:00:00Z"),
      listedSlug: "my-workflow",
      inputSchema: { type: "object" },
    });
    mockUpdateReturning.mockResolvedValue([updated]);

    const response = await PATCH(createRequest("PATCH", { isListed: true }), {
      params: mockParams,
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.isListed).toBe(true);
    expect(data.listedAt).not.toBeNull();
  });

  it("LIST-02 immutability: PATCH with different listedSlug on already-slugged workflow returns 400", async () => {
    const existing = makeWorkflow({
      isListed: true,
      listedSlug: "old-slug",
      listedAt: new Date(),
    });
    mockWorkflowsFindFirst.mockResolvedValue(existing);

    const response = await PATCH(
      createRequest("PATCH", { listedSlug: "new-slug" }),
      { params: mockParams }
    );

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain("slug cannot be changed");
  });

  it("LIST-02 allows: PATCH with listedSlug on unlisted workflow (isListed=false) succeeds", async () => {
    const existing = makeWorkflow({
      isListed: false,
      listedSlug: "old-slug",
      listedAt: null,
    });
    mockWorkflowsFindFirst.mockResolvedValue(existing);

    const updated = makeWorkflow({
      isListed: false,
      listedSlug: "new-slug",
      listedAt: null,
    });
    mockUpdateReturning.mockResolvedValue([updated]);

    const response = await PATCH(
      createRequest("PATCH", { listedSlug: "new-slug" }),
      { params: mockParams }
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.listedSlug).toBe("new-slug");
  });

  it("LIST-02 uniqueness: db.update throwing with cause.code 23505 returns 400", async () => {
    const existing = makeWorkflow({ listedSlug: null, listedAt: null });
    mockWorkflowsFindFirst.mockResolvedValue(existing);

    const dbError = new Error("duplicate key value");
    (dbError as Error & { cause: unknown }).cause = { code: "23505" };
    mockUpdateReturning.mockRejectedValue(dbError);

    const response = await PATCH(
      createRequest("PATCH", { listedSlug: "my-slug" }),
      { params: mockParams }
    );

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain("already in use");
  });

  it("LIST-05: PATCH with priceUsdcPerCall field is accepted and returned", async () => {
    const existing = makeWorkflow();
    mockWorkflowsFindFirst.mockResolvedValue(existing);

    const updated = makeWorkflow({ priceUsdcPerCall: "1.50" });
    mockUpdateReturning.mockResolvedValue([updated]);

    const response = await PATCH(
      createRequest("PATCH", { priceUsdcPerCall: "1.50" }),
      { params: mockParams }
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.priceUsdcPerCall).toBe("1.50");
  });

  it("Unlist preserves listedSlug, listedAt, and all listing data", async () => {
    const listedAt = new Date("2026-03-01T00:00:00Z");
    const existing = makeWorkflow({
      isListed: true,
      listedSlug: "my-workflow",
      listedAt,
      priceUsdcPerCall: "2.00",
    });
    mockWorkflowsFindFirst.mockResolvedValue(existing);

    const updated = makeWorkflow({
      isListed: false,
      listedSlug: "my-workflow",
      listedAt,
      priceUsdcPerCall: "2.00",
    });
    mockUpdateReturning.mockResolvedValue([updated]);

    const response = await PATCH(createRequest("PATCH", { isListed: false }), {
      params: mockParams,
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.isListed).toBe(false);
    expect(data.listedSlug).toBe("my-workflow");
    expect(data.listedAt).not.toBeNull();
    expect(data.priceUsdcPerCall).toBe("2.00");
  });

  // ──────────────────────────────────────────────────────────────────────
  // Edit-while-listed re-validation
  // ──────────────────────────────────────────────────────────────────────

  const badNode = {
    id: "webhook-1",
    type: "action",
    data: {
      type: "action",
      config: {
        actionType: "webhook/send-webhook",
        webhookUrl: "https://example.com",
        webhookMethod: "POST",
        webhookPayload: "@40",
      },
    },
  };
  const goodNode = {
    id: "webhook-1",
    type: "action",
    data: {
      type: "action",
      config: {
        actionType: "webhook/send-webhook",
        webhookUrl: "https://example.com",
        webhookMethod: "POST",
      },
    },
  };

  it("LIST-VALIDATE bare-@ on listed: rejects with 422 INVALID_TEMPLATE_LITERALS", async () => {
    const existing = makeWorkflow({
      isListed: true,
      listedSlug: "live-wf",
      listedAt: new Date(),
      inputSchema: { type: "object" },
      nodes: [goodNode],
    });
    mockWorkflowsFindFirst.mockResolvedValue(existing);

    const response = await PATCH(
      createRequest("PATCH", { nodes: [badNode], edges: [] }),
      { params: mockParams }
    );

    expect(response.status).toBe(422);
    const data = await response.json();
    expect(data.error).toBe("INVALID_TEMPLATE_LITERALS");
    expect(data.literals).toContain("@40");
    expect(mockUpdateReturning).not.toHaveBeenCalled();
  });

  it("KEEP-467: PATCH rejects invalid action config before updating workflow", async () => {
    mockWorkflowsFindFirst.mockResolvedValue(makeWorkflow());

    const response = await PATCH(
      createRequest("PATCH", {
        nodes: [
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
        ],
        edges: [],
      }),
      { params: mockParams }
    );

    const data = await response.json();

    expect(response.status).toBe(422);
    expect(data.error).toBe("INVALID_ACTION_CONFIG");
    expect(data.invalidFields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "UNKNOWN_FIELD", field: "Message" }),
        expect.objectContaining({
          code: "MISSING_REQUIRED_FIELD",
          field: "discordMessage",
        }),
      ])
    );
    expect(mockUpdateReturning).not.toHaveBeenCalled();
  });

  it("KEEP-467: PATCH rejects unknown action types before updating workflow", async () => {
    mockWorkflowsFindFirst.mockResolvedValue(makeWorkflow());

    const response = await PATCH(
      createRequest("PATCH", {
        nodes: [
          {
            id: "node-1",
            type: "action",
            data: {
              type: "action",
              config: {
                actionType: "webhook/send",
                webhookUrl: "https://example.com",
              },
            },
          },
        ],
        edges: [],
      }),
      { params: mockParams }
    );

    const data = await response.json();

    expect(response.status).toBe(422);
    expect(data.invalidFields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "UNKNOWN_ACTION_TYPE" }),
      ])
    );
    expect(mockUpdateReturning).not.toHaveBeenCalled();
  });

  it("KEEP-467: PATCH rejects invalid typed protocol fields before updating workflow", async () => {
    mockWorkflowsFindFirst.mockResolvedValue(makeWorkflow());

    const response = await PATCH(
      createRequest("PATCH", {
        nodes: [
          {
            id: "node-1",
            type: "action",
            data: {
              type: "action",
              config: {
                actionType: "aave-v3/supply",
                network: "1",
                asset: "not-an-address",
                amount: "1000000000000000000",
                onBehalfOf: "0x0000000000000000000000000000000000000001",
              },
            },
          },
        ],
        edges: [],
      }),
      { params: mockParams }
    );

    const data = await response.json();

    expect(response.status).toBe(422);
    expect(data.invalidFields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "INVALID_FIELD_TYPE",
          field: "asset",
        }),
      ])
    );
    expect(mockUpdateReturning).not.toHaveBeenCalled();
  });

  it("KEEP-571: PATCH accepts a 3+ node workflow whose web3/read-contract uses stringified functionArgs (UI wire format)", async () => {
    mockWorkflowsFindFirst.mockResolvedValue(makeWorkflow());
    mockUpdateReturning.mockResolvedValue([makeWorkflow()]);

    const response = await PATCH(
      createRequest("PATCH", {
        nodes: [
          {
            id: "trigger",
            type: "trigger",
            data: {
              type: "trigger",
              config: { actionType: "Manual" },
            },
          },
          {
            id: "read-1",
            type: "action",
            data: {
              type: "action",
              config: {
                actionType: "web3/read-contract",
                network: "1",
                contractAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
                abi: JSON.stringify([
                  {
                    inputs: [
                      { internalType: "bytes32", name: "id", type: "bytes32" },
                    ],
                    name: "reader",
                    outputs: [
                      { internalType: "uint256", name: "Art", type: "uint256" },
                    ],
                    stateMutability: "view",
                    type: "function",
                  },
                ]),
                abiFunction: "reader",
                functionArgs:
                  '["{{@prev-loop:Prev Loop.currentItem.idBytes32}}"]',
              },
            },
          },
          {
            id: "msg-1",
            type: "action",
            data: {
              type: "action",
              config: {
                actionType: "discord/send-message",
                discordMessage: "id read",
              },
            },
          },
        ],
        edges: [],
      }),
      { params: mockParams }
    );

    expect(response.status).toBe(200);
    expect(mockUpdateReturning).toHaveBeenCalled();
  });

  it("KEEP-571: PATCH accepts legacy `functionName` on web3/write-contract (legacy functionName case)", async () => {
    mockWorkflowsFindFirst.mockResolvedValue(makeWorkflow());
    mockUpdateReturning.mockResolvedValue([makeWorkflow()]);

    const response = await PATCH(
      createRequest("PATCH", {
        nodes: [
          {
            id: "trigger",
            type: "trigger",
            data: {
              type: "trigger",
              config: { actionType: "Manual" },
            },
          },
          {
            id: "doWrite-1",
            type: "action",
            data: {
              type: "action",
              config: {
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
                functionName: "doWrite",
                functionArgs: "[]",
              },
            },
          },
          {
            id: "notify",
            type: "action",
            data: {
              type: "action",
              config: {
                actionType: "discord/send-message",
                discordMessage: "done",
              },
            },
          },
        ],
        edges: [],
      }),
      { params: mockParams }
    );

    expect(response.status).toBe(200);
    expect(mockUpdateReturning).toHaveBeenCalled();
  });

  it("KEEP-571: PATCH still rejects bogus values for stringified container fields", async () => {
    mockWorkflowsFindFirst.mockResolvedValue(makeWorkflow());

    const response = await PATCH(
      createRequest("PATCH", {
        nodes: [
          {
            id: "trigger",
            type: "trigger",
            data: {
              type: "trigger",
              config: { actionType: "Manual" },
            },
          },
          {
            id: "read-1",
            type: "action",
            data: {
              type: "action",
              config: {
                actionType: "web3/read-contract",
                network: "1",
                contractAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
                abi: "[]",
                abiFunction: "reader",
                functionArgs: "this-is-not-json-or-a-template",
              },
            },
          },
        ],
        edges: [],
      }),
      { params: mockParams }
    );

    const data = await response.json();

    expect(response.status).toBe(422);
    expect(data.error).toBe("INVALID_ACTION_CONFIG");
    expect(data.invalidFields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "INVALID_FIELD_TYPE",
          field: "functionArgs",
        }),
      ])
    );
    expect(mockUpdateReturning).not.toHaveBeenCalled();
  });

  it("KEEP-571: PATCH accepts useManualAbi UI state on web3 actions (global reserved key)", async () => {
    mockWorkflowsFindFirst.mockResolvedValue(makeWorkflow());
    mockUpdateReturning.mockResolvedValue([makeWorkflow()]);

    const response = await PATCH(
      createRequest("PATCH", {
        nodes: [
          {
            id: "trigger",
            type: "trigger",
            data: { type: "trigger", config: { actionType: "Manual" } },
          },
          {
            id: "read-1",
            type: "action",
            data: {
              type: "action",
              config: {
                actionType: "web3/read-contract",
                network: "1",
                contractAddress: "0x0000000000000000000000000000000000000001",
                abi: "[]",
                abiFunction: "reader",
                functionArgs: "[]",
                useManualAbi: "true",
              },
            },
          },
        ],
        edges: [],
      }),
      { params: mockParams }
    );

    expect(response.status).toBe(200);
    expect(mockUpdateReturning).toHaveBeenCalled();
  });

  it("KEEP-571: PATCH accepts inputMode/batchSize leak on web3/query-transactions", async () => {
    mockWorkflowsFindFirst.mockResolvedValue(makeWorkflow());
    mockUpdateReturning.mockResolvedValue([makeWorkflow()]);

    const response = await PATCH(
      createRequest("PATCH", {
        nodes: [
          {
            id: "trigger",
            type: "trigger",
            data: { type: "trigger", config: { actionType: "Manual" } },
          },
          {
            id: "query-1",
            type: "action",
            data: {
              type: "action",
              config: {
                actionType: "web3/query-transactions",
                network: "1",
                contractAddress: "0x0000000000000000000000000000000000000001",
                abi: "[]",
                abiFunction: "doWrite",
                inputMode: "uniform",
                batchSize: "100",
                blockCount: "225000",
                useManualAbi: "true",
              },
            },
          },
        ],
        edges: [],
      }),
      { params: mockParams }
    );

    expect(response.status).toBe(200);
    expect(mockUpdateReturning).toHaveBeenCalled();
  });

  it("KEEP-571: PATCH saves a 6-node workflow with the affected node at index 3 (proves node-count is not a threshold)", async () => {
    mockWorkflowsFindFirst.mockResolvedValue(makeWorkflow());
    mockUpdateReturning.mockResolvedValue([makeWorkflow()]);

    const readContractAbi = JSON.stringify([
      {
        inputs: [{ internalType: "bytes32", name: "id", type: "bytes32" }],
        name: "reader",
        outputs: [{ internalType: "uint256", name: "Art", type: "uint256" }],
        stateMutability: "view",
        type: "function",
      },
    ]);

    const fillerNode = (id: string): Record<string, unknown> => ({
      id,
      type: "action",
      data: {
        type: "action",
        config: {
          actionType: "discord/send-message",
          discordMessage: `msg-${id}`,
        },
      },
    });

    const response = await PATCH(
      createRequest("PATCH", {
        nodes: [
          {
            id: "trigger",
            type: "trigger",
            data: { type: "trigger", config: { actionType: "Manual" } },
          },
          fillerNode("n-1"),
          fillerNode("n-2"),
          {
            id: "read-3",
            type: "action",
            data: {
              type: "action",
              config: {
                actionType: "web3/read-contract",
                network: "1",
                contractAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
                abi: readContractAbi,
                abiFunction: "reader",
                functionArgs:
                  '["0x0000000000000000000000000000000000000000000000000000000000000001"]',
              },
            },
          },
          fillerNode("n-4"),
          fillerNode("n-5"),
        ],
        edges: [],
      }),
      { params: mockParams }
    );

    expect(response.status).toBe(200);
    expect(mockUpdateReturning).toHaveBeenCalled();
  });

  it("KEEP-571: PATCH saves a 10-node workflow with two affected read-contract nodes at different indices", async () => {
    mockWorkflowsFindFirst.mockResolvedValue(makeWorkflow());
    mockUpdateReturning.mockResolvedValue([makeWorkflow()]);

    const readAbi = JSON.stringify([
      {
        inputs: [],
        name: "totalSupply",
        outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
        stateMutability: "view",
        type: "function",
      },
    ]);

    const filler = (id: string): Record<string, unknown> => ({
      id,
      type: "action",
      data: {
        type: "action",
        config: {
          actionType: "discord/send-message",
          discordMessage: id,
        },
      },
    });

    const readContract = (id: string): Record<string, unknown> => ({
      id,
      type: "action",
      data: {
        type: "action",
        config: {
          actionType: "web3/read-contract",
          network: "1",
          contractAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
          abi: readAbi,
          abiFunction: "totalSupply",
          functionArgs: "[]",
        },
      },
    });

    const nodes: Record<string, unknown>[] = [
      {
        id: "trigger",
        type: "trigger",
        data: { type: "trigger", config: { actionType: "Manual" } },
      },
    ];
    for (let i = 1; i <= 9; i++) {
      if (i === 2 || i === 7) {
        nodes.push(readContract(`r-${i}`));
      } else {
        nodes.push(filler(`f-${i}`));
      }
    }

    const response = await PATCH(createRequest("PATCH", { nodes, edges: [] }), {
      params: mockParams,
    });

    expect(response.status).toBe(200);
    expect(mockUpdateReturning).toHaveBeenCalled();
  });

  it("KEEP-571: PATCH still surfaces correct node-index paths in invalidFields for large workflows", async () => {
    mockWorkflowsFindFirst.mockResolvedValue(makeWorkflow());

    const filler = (id: string): Record<string, unknown> => ({
      id,
      type: "action",
      data: {
        type: "action",
        config: {
          actionType: "discord/send-message",
          discordMessage: id,
        },
      },
    });

    const nodes: Record<string, unknown>[] = [
      {
        id: "trigger",
        type: "trigger",
        data: { type: "trigger", config: { actionType: "Manual" } },
      },
      filler("f-1"),
      filler("f-2"),
      filler("f-3"),
      {
        id: "bad-4",
        type: "action",
        data: {
          type: "action",
          config: {
            actionType: "web3/read-contract",
            network: "1",
            contractAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
            abi: "[]",
            abiFunction: "reader",
            functionArgs: "not-json",
          },
        },
      },
      filler("f-5"),
    ];

    const response = await PATCH(createRequest("PATCH", { nodes, edges: [] }), {
      params: mockParams,
    });

    expect(response.status).toBe(422);
    const data = await response.json();
    expect(data.invalidFields).toEqual([
      expect.objectContaining({
        code: "INVALID_FIELD_TYPE",
        path: "nodes[4].data.config.functionArgs",
        field: "functionArgs",
      }),
    ]);
    expect(mockUpdateReturning).not.toHaveBeenCalled();
  });

  it("KEEP-571: PATCH with a 1-node workflow (trigger only, no actions) succeeds", async () => {
    mockWorkflowsFindFirst.mockResolvedValue(makeWorkflow());
    mockUpdateReturning.mockResolvedValue([makeWorkflow()]);

    const response = await PATCH(
      createRequest("PATCH", {
        nodes: [
          {
            id: "trigger",
            type: "trigger",
            data: { type: "trigger", config: { actionType: "Manual" } },
          },
        ],
        edges: [],
      }),
      { params: mockParams }
    );

    expect(response.status).toBe(200);
    expect(mockUpdateReturning).toHaveBeenCalled();
  });

  it("KEEP-571: PATCH with a 2-node workflow (trigger + single read-contract using stringified args) succeeds", async () => {
    mockWorkflowsFindFirst.mockResolvedValue(makeWorkflow());
    mockUpdateReturning.mockResolvedValue([makeWorkflow()]);

    const response = await PATCH(
      createRequest("PATCH", {
        nodes: [
          {
            id: "trigger",
            type: "trigger",
            data: { type: "trigger", config: { actionType: "Manual" } },
          },
          {
            id: "read-1",
            type: "action",
            data: {
              type: "action",
              config: {
                actionType: "web3/read-contract",
                network: "1",
                contractAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
                abi: "[]",
                abiFunction: "balanceOf",
                functionArgs: '["{{trigger.walletAddress}}"]',
              },
            },
          },
        ],
        edges: [],
      }),
      { params: mockParams }
    );

    expect(response.status).toBe(200);
    expect(mockUpdateReturning).toHaveBeenCalled();
  });

  it("KEEP-571: PATCH with empty nodes array succeeds (cleared workflow)", async () => {
    mockWorkflowsFindFirst.mockResolvedValue(makeWorkflow());
    mockUpdateReturning.mockResolvedValue([makeWorkflow()]);

    const response = await PATCH(
      createRequest("PATCH", { nodes: [], edges: [] }),
      { params: mockParams }
    );

    expect(response.status).toBe(200);
    expect(mockUpdateReturning).toHaveBeenCalled();
  });

  it("KEEP-571: PATCH without nodes in body (partial update) skips action-config validation", async () => {
    mockWorkflowsFindFirst.mockResolvedValue(makeWorkflow());
    mockUpdateReturning.mockResolvedValue([makeWorkflow()]);

    const response = await PATCH(
      createRequest("PATCH", { name: "Renamed only" }),
      { params: mockParams }
    );

    expect(response.status).toBe(200);
    expect(mockUpdateReturning).toHaveBeenCalled();
  });

  it("KEEP-467: PATCH validates integration ownership after sanitizer moves misplaced config fields", async () => {
    mockWorkflowsFindFirst.mockResolvedValue(makeWorkflow());
    mockValidateWorkflowIntegrations.mockResolvedValue({
      valid: false,
      invalidIds: ["foreign-integration"],
    });

    const response = await PATCH(
      createRequest("PATCH", {
        nodes: [
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
        ],
        edges: [],
      }),
      { params: mockParams }
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
    expect(mockUpdateReturning).not.toHaveBeenCalled();
  });

  it("LIST-VALIDATE bare-@ on unlisted: PATCH succeeds (gate only fires when listed)", async () => {
    const existing = makeWorkflow({
      isListed: false,
      nodes: [goodNode],
    });
    mockWorkflowsFindFirst.mockResolvedValue(existing);
    mockUpdateReturning.mockResolvedValue([
      makeWorkflow({ isListed: false, nodes: [badNode] }),
    ]);

    const response = await PATCH(
      createRequest("PATCH", { nodes: [badNode], edges: [] }),
      { params: mockParams }
    );

    expect(response.status).toBe(200);
  });

  it("LIST-VALIDATE null inputSchema on listed: rejects with 422 INPUT_SCHEMA_REQUIRED", async () => {
    const existing = makeWorkflow({
      isListed: true,
      listedSlug: "live-wf",
      listedAt: new Date(),
      inputSchema: { type: "object" },
      nodes: [goodNode],
    });
    mockWorkflowsFindFirst.mockResolvedValue(existing);

    const response = await PATCH(
      createRequest("PATCH", { inputSchema: null }),
      {
        params: mockParams,
      }
    );

    expect(response.status).toBe(422);
    const data = await response.json();
    expect(data.error).toBe("INPUT_SCHEMA_REQUIRED");
    expect(mockUpdateReturning).not.toHaveBeenCalled();
  });

  it("LIST-VALIDATE transition to listed with bare-@ in existing nodes: rejects", async () => {
    // Backdoor: workflow was created with bare-@ in a node (out-of-band) and
    // the user now PATCHes isListed=true here. The transition-to-listed branch
    // validates the full final state, not just patched fields.
    const existing = makeWorkflow({
      isListed: false,
      listedSlug: "live-wf",
      inputSchema: { type: "object" },
      nodes: [badNode],
    });
    mockWorkflowsFindFirst.mockResolvedValue(existing);

    const response = await PATCH(createRequest("PATCH", { isListed: true }), {
      params: mockParams,
    });

    expect(response.status).toBe(422);
    const data = await response.json();
    expect(data.error).toBe("INVALID_TEMPLATE_LITERALS");
  });

  it("LIST-VALIDATE transition to listed with null existing inputSchema: rejects", async () => {
    const existing = makeWorkflow({
      isListed: false,
      listedSlug: "live-wf",
      inputSchema: null,
      nodes: [goodNode],
    });
    mockWorkflowsFindFirst.mockResolvedValue(existing);

    const response = await PATCH(createRequest("PATCH", { isListed: true }), {
      params: mockParams,
    });

    expect(response.status).toBe(422);
    const data = await response.json();
    expect(data.error).toBe("INPUT_SCHEMA_REQUIRED");
  });

  it("LIST-VALIDATE unlist+cleanup: PATCH {isListed: false, nodes: [bad]} on listed workflow succeeds", async () => {
    // The workflow is leaving the listed surface in this same PATCH — the
    // bazaar will never see the post-patch state, so blocking the user from
    // unlisting+cleaning-up in one shot is unnecessary friction. The gate
    // explicitly skips when body.isListed === false on a currently-listed row.
    const existing = makeWorkflow({
      isListed: true,
      listedSlug: "live-wf",
      listedAt: new Date(),
      inputSchema: { type: "object" },
      nodes: [goodNode],
    });
    mockWorkflowsFindFirst.mockResolvedValue(existing);
    mockUpdateReturning.mockResolvedValue([
      makeWorkflow({
        isListed: false,
        listedSlug: "live-wf",
        listedAt: new Date(),
        inputSchema: { type: "object" },
        nodes: [badNode],
      }),
    ]);

    const response = await PATCH(
      createRequest("PATCH", { isListed: false, nodes: [badNode], edges: [] }),
      { params: mockParams }
    );

    expect(response.status).toBe(200);
  });

  it("LIST-VALIDATE unlist+null-schema: PATCH {isListed: false, inputSchema: null} on listed workflow succeeds", async () => {
    const existing = makeWorkflow({
      isListed: true,
      listedSlug: "live-wf",
      listedAt: new Date(),
      inputSchema: { type: "object" },
      nodes: [goodNode],
    });
    mockWorkflowsFindFirst.mockResolvedValue(existing);
    mockUpdateReturning.mockResolvedValue([
      makeWorkflow({ isListed: false, inputSchema: null }),
    ]);

    const response = await PATCH(
      createRequest("PATCH", { isListed: false, inputSchema: null }),
      { params: mockParams }
    );

    expect(response.status).toBe(200);
  });

  it("LIST-VALIDATE write-action removed on listed write workflow: rejects MISSING_WRITE_ACTION", async () => {
    // Third publish-time gate: an author can publish a write workflow then
    // PATCH `nodes` here to remove the only write-action node, leaving the
    // listing live but executing nothing meaningful. Same backdoor class as
    // bare-@ on listed.
    const writeNode = {
      id: "write-1",
      type: "action",
      data: {
        type: "action",
        config: {
          actionType: "web3/write-contract",
          contractAddress: "0xabc",
          network: "1",
          abi: "[]",
          abiFunction: "transfer",
        },
      },
    };
    const existing = makeWorkflow({
      isListed: true,
      listedSlug: "live-write",
      listedAt: new Date(),
      inputSchema: { type: "object" },
      workflowType: "write",
      nodes: [writeNode],
    });
    mockWorkflowsFindFirst.mockResolvedValue(existing);

    const response = await PATCH(
      createRequest("PATCH", { nodes: [goodNode], edges: [] }),
      { params: mockParams }
    );

    expect(response.status).toBe(422);
    const data = await response.json();
    expect(data.error).toBe("MISSING_WRITE_ACTION");
    expect(mockUpdateReturning).not.toHaveBeenCalled();
  });

  it("LIST-VALIDATE inputSchema as array: rejects INPUT_SCHEMA_REQUIRED", async () => {
    // Edge case: arrays are objects per typeof but not valid JSON-schema
    // shapes. isInputSchemaPresent rejects them.
    const existing = makeWorkflow({
      isListed: true,
      listedSlug: "live-wf",
      listedAt: new Date(),
      inputSchema: { type: "object" },
      nodes: [goodNode],
    });
    mockWorkflowsFindFirst.mockResolvedValue(existing);

    const response = await PATCH(createRequest("PATCH", { inputSchema: [] }), {
      params: mockParams,
    });

    expect(response.status).toBe(422);
    const data = await response.json();
    expect(data.error).toBe("INPUT_SCHEMA_REQUIRED");
  });

  it("LIST-VALIDATE messaging-skip on listed: PATCH adding @everyone in discord/* node still succeeds", async () => {
    // The findBareAtLiterals validator skips action types in the messaging
    // skip-list (discord/*, slack/*, telegram/*, email/*, ai/*, ai-gateway/*,
    // code/*). A PATCH that adds a Discord node with @everyone in the message
    // body must not 422 — same skip semantics as the publish path.
    const discordNode = {
      id: "discord-1",
      type: "action",
      data: {
        type: "action",
        config: {
          actionType: "discord/send-message",
          discordMessage: "Alert @here token spiked, @user1 please review",
        },
      },
    };
    const existing = makeWorkflow({
      isListed: true,
      listedSlug: "live-wf",
      listedAt: new Date(),
      inputSchema: { type: "object" },
      nodes: [goodNode],
    });
    mockWorkflowsFindFirst.mockResolvedValue(existing);
    mockUpdateReturning.mockResolvedValue([
      makeWorkflow({
        isListed: true,
        listedSlug: "live-wf",
        listedAt: new Date(),
        inputSchema: { type: "object" },
        nodes: [discordNode],
      }),
    ]);

    const response = await PATCH(
      createRequest("PATCH", { nodes: [discordNode], edges: [] }),
      { params: mockParams }
    );

    expect(response.status).toBe(200);
  });

  it("LIST-VALIDATE transition to listed write workflow with read-only nodes: rejects MISSING_WRITE_ACTION", async () => {
    // Covers the isTransitioningToListed branch of the write-action gate —
    // the previous PATCH-route tests only exercised the already-listed branch.
    // This is also the only realistic way to reach the gate via this route
    // since workflowType isn't editable here (curator-only).
    const existing = makeWorkflow({
      isListed: false,
      listedAt: null,
      listedSlug: "live-write",
      workflowType: "write",
      inputSchema: { type: "object" },
      nodes: [goodNode], // read-only node, no write-action
    });
    mockWorkflowsFindFirst.mockResolvedValue(existing);

    const response = await PATCH(createRequest("PATCH", { isListed: true }), {
      params: mockParams,
    });

    expect(response.status).toBe(422);
    const data = await response.json();
    expect(data.error).toBe("MISSING_WRITE_ACTION");
    expect(mockUpdateReturning).not.toHaveBeenCalled();
  });

  it("LIST-VALIDATE legacy write: PATCH only-description on listed write workflow with no write nodes still succeeds", async () => {
    // Backwards-compat for legacy listings: a workflowType=write row that
    // somehow exists with only read-only nodes (e.g. predates the publish
    // gate, or was corrupted out-of-band) should keep accepting metadata
    // edits via the workflows-PATCH route as long as the patch doesn't
    // touch nodes. The curator path (updateWorkflowListing) is stricter
    // and would reject — that's the documented asymmetry.
    const existing = makeWorkflow({
      isListed: true,
      listedSlug: "legacy-write",
      listedAt: new Date(),
      workflowType: "write",
      inputSchema: { type: "object" },
      nodes: [goodNode], // read-only, no write-action
    });
    mockWorkflowsFindFirst.mockResolvedValue(existing);
    mockUpdateReturning.mockResolvedValue([
      makeWorkflow({
        isListed: true,
        listedSlug: "legacy-write",
        listedAt: new Date(),
        workflowType: "write",
        inputSchema: { type: "object" },
        nodes: [goodNode],
        description: "updated text",
      }),
    ]);

    const response = await PATCH(
      createRequest("PATCH", { description: "updated text" }),
      { params: mockParams }
    );

    expect(response.status).toBe(200);
  });

  it("LIST-VALIDATE legacy: PATCH on listed workflow with null inputSchema, not touching nodes or schema, still succeeds", async () => {
    // Backwards-compat: workflows listed before the gates existed have null
    // inputSchema. They should keep working until the next PATCH that touches
    // nodes or schema. PATCH that only changes other fields (e.g. description)
    // must not retroactively reject them.
    const existing = makeWorkflow({
      isListed: true,
      listedSlug: "legacy",
      listedAt: new Date(),
      inputSchema: null,
      nodes: [goodNode],
    });
    mockWorkflowsFindFirst.mockResolvedValue(existing);
    mockUpdateReturning.mockResolvedValue([
      makeWorkflow({
        isListed: true,
        listedSlug: "legacy",
        listedAt: new Date(),
        inputSchema: null,
        nodes: [goodNode],
        description: "updated text",
      }),
    ]);

    const response = await PATCH(
      createRequest("PATCH", { description: "updated text" }),
      { params: mockParams }
    );

    expect(response.status).toBe(200);
  });

  // ──────────────────────────────────────────────────────────────────────
  // SLUG_REQUIRED gate: a listed workflow must always carry a slug, so this
  // backdoor PATCH cannot create the discoverable-but-uncallable rows that
  // appeared in /api/workflows/public. Mirrors the curator route's code.
  // ──────────────────────────────────────────────────────────────────────

  it("SLUG-GATE transition to listed with no slug: rejects 422 SLUG_REQUIRED, does not persist", async () => {
    const existing = makeWorkflow({
      isListed: false,
      listedAt: null,
      listedSlug: null,
      inputSchema: { type: "object" },
    });
    mockWorkflowsFindFirst.mockResolvedValue(existing);

    const response = await PATCH(createRequest("PATCH", { isListed: true }), {
      params: mockParams,
    });

    expect(response.status).toBe(422);
    const data = await response.json();
    expect(data.error).toBe("SLUG_REQUIRED");
    expect(mockUpdateReturning).not.toHaveBeenCalled();
  });

  it("SLUG-GATE transition to listed with a slug supplied in the body: succeeds", async () => {
    const existing = makeWorkflow({
      isListed: false,
      listedAt: null,
      listedSlug: null,
      inputSchema: { type: "object" },
    });
    mockWorkflowsFindFirst.mockResolvedValue(existing);
    mockUpdateReturning.mockResolvedValue([
      makeWorkflow({
        isListed: true,
        listedSlug: "fresh-slug",
        listedAt: new Date(),
        inputSchema: { type: "object" },
      }),
    ]);

    const response = await PATCH(
      createRequest("PATCH", { isListed: true, listedSlug: "fresh-slug" }),
      { params: mockParams }
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.isListed).toBe(true);
    expect(data.listedSlug).toBe("fresh-slug");
  });

  it("SLUG-GATE blank/whitespace slug while transitioning to listed: rejects 422 SLUG_REQUIRED", async () => {
    const existing = makeWorkflow({
      isListed: false,
      listedAt: null,
      listedSlug: null,
      inputSchema: { type: "object" },
    });
    mockWorkflowsFindFirst.mockResolvedValue(existing);

    const response = await PATCH(
      createRequest("PATCH", { isListed: true, listedSlug: "   " }),
      { params: mockParams }
    );

    expect(response.status).toBe(422);
    const data = await response.json();
    expect(data.error).toBe("SLUG_REQUIRED");
    expect(mockUpdateReturning).not.toHaveBeenCalled();
  });

  it("SLUG-GATE trims a padded slug before persisting it", async () => {
    const existing = makeWorkflow({
      isListed: false,
      listedAt: null,
      listedSlug: null,
      inputSchema: { type: "object" },
    });
    mockWorkflowsFindFirst.mockResolvedValue(existing);
    mockUpdateReturning.mockResolvedValue([
      makeWorkflow({
        isListed: true,
        listedSlug: "padded-slug",
        listedAt: new Date(),
        inputSchema: { type: "object" },
      }),
    ]);

    const response = await PATCH(
      createRequest("PATCH", {
        isListed: true,
        listedSlug: "  padded-slug  ",
      }),
      { params: mockParams }
    );

    expect(response.status).toBe(200);
    expect(capturedSet.data?.listedSlug).toBe("padded-slug");
  });

  it("SLUG-GATE edit nodes on an already-listed workflow with a sticky slug: succeeds (no false reject)", async () => {
    const existing = makeWorkflow({
      isListed: true,
      listedSlug: "live-wf",
      listedAt: new Date(),
      inputSchema: { type: "object" },
      nodes: [goodNode],
    });
    mockWorkflowsFindFirst.mockResolvedValue(existing);
    mockUpdateReturning.mockResolvedValue([
      makeWorkflow({
        isListed: true,
        listedSlug: "live-wf",
        listedAt: new Date(),
        inputSchema: { type: "object" },
        nodes: [goodNode],
      }),
    ]);

    const response = await PATCH(
      createRequest("PATCH", { nodes: [goodNode], edges: [] }),
      { params: mockParams }
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.listedSlug).toBe("live-wf");
  });

  it("SLUG-GATE unlist an orphaned listed-but-slugless row: succeeds (cleanup bypass)", async () => {
    // The migration unlists these rows in bulk, but the API must also let a
    // user unlist one directly: isListed=false makes willBeListed false, so the
    // slug gate is skipped on the way out.
    const existing = makeWorkflow({
      isListed: true,
      listedSlug: null,
      listedAt: new Date(),
      inputSchema: { type: "object" },
    });
    mockWorkflowsFindFirst.mockResolvedValue(existing);
    mockUpdateReturning.mockResolvedValue([
      makeWorkflow({ isListed: false, listedSlug: null }),
    ]);

    const response = await PATCH(createRequest("PATCH", { isListed: false }), {
      params: mockParams,
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.isListed).toBe(false);
  });
});

describe("GET /api/workflows/[workflowId] — description sanitization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelectFrom.mockResolvedValue([]);
    mockMemberLimit.mockResolvedValue([{ id: "member-1" }]);
  });

  it("LIST-06 + INFRA-05: non-owner GET on listed workflow receives sanitized description", async () => {
    // Non-owner, different org
    mockGetDualAuthContext.mockResolvedValue({
      userId: "other-user",
      organizationId: "other-org",
      authMethod: "session",
    });

    const workflow = makeWorkflow({
      isListed: true,
      visibility: "public",
      description: "## Hello **world**",
    });
    mockWorkflowsFindFirst.mockResolvedValue(workflow);

    const response = await GET(createRequest("GET"), { params: mockParams });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.description).toMatch(SANITIZED_PREFIX_RE);
  });

  it("LIST-06 owner: owner GET on listed workflow receives raw description", async () => {
    // Owner
    mockGetDualAuthContext.mockResolvedValue({
      userId: "user-123",
      organizationId: "org-123",
      authMethod: "session",
    });

    const workflow = makeWorkflow({
      isListed: true,
      description: "## Hello **world**",
    });
    mockWorkflowsFindFirst.mockResolvedValue(workflow);

    const response = await GET(createRequest("GET"), { params: mockParams });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.description).toBe("## Hello **world**");
    expect(data.description).not.toMatch(SANITIZED_PREFIX_RE);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// workflowType is auto-derived from content on every PATCH: a callable
// write node forces "write", overriding a persisted "read". Detection
// matches the calldata generator, so value transfers/approvals do not
// qualify (labelling them write would make call_workflow fail at runtime).
// ─────────────────────────────────────────────────────────────────────────

describe("PATCH /api/workflows/[workflowId] — workflowType auto-flip", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedSet.data = null;
    mockGetDualAuthContext.mockResolvedValue({
      userId: "user-123",
      organizationId: "org-123",
      authMethod: "session",
    });
    mockValidateWorkflowIntegrations.mockResolvedValue({ valid: true });
    mockSelectFrom.mockResolvedValue([]);
    mockMemberLimit.mockResolvedValue([{ id: "member-1" }]);
  });

  const WRITE_CONTRACT_NODE = {
    id: "write-1",
    type: "action",
    data: {
      type: "action",
      config: {
        actionType: "web3/write-contract",
        contractAddress: "0xabc",
        network: "11155111",
        abi: "[]",
        abiFunction: "transfer",
      },
    },
  };

  it("auto-flips workflowType to 'write' when PATCH adds a write-contract node", async () => {
    const existing = makeWorkflow({ workflowType: "read", nodes: [] });
    mockWorkflowsFindFirst.mockResolvedValue(existing);
    mockUpdateReturning.mockResolvedValue([
      makeWorkflow({ workflowType: "write", nodes: [WRITE_CONTRACT_NODE] }),
    ]);

    const response = await PATCH(
      createRequest("PATCH", {
        nodes: [WRITE_CONTRACT_NODE],
        edges: [],
      }),
      { params: mockParams }
    );

    expect(response.status).toBe(200);
    expect(capturedSet.data?.workflowType).toBe("write");
  });

  it("does NOT flip workflowType when PATCH has no callable write node", async () => {
    // The narrow-detector decision (transfers/approvals don't qualify) is
    // unit-tested in workflow-listing-lifecycle.test.ts. Here we just confirm
    // the route doesn't spuriously touch workflowType when nothing in the
    // node set matches the calldata detector.
    const existing = makeWorkflow({ workflowType: "read", nodes: [] });
    mockWorkflowsFindFirst.mockResolvedValue(existing);
    mockUpdateReturning.mockResolvedValue([
      makeWorkflow({ workflowType: "read", nodes: [] }),
    ]);

    const response = await PATCH(
      createRequest("PATCH", { nodes: [], edges: [] }),
      { params: mockParams }
    );

    expect(response.status).toBe(200);
    expect(capturedSet.data?.workflowType).toBeUndefined();
  });

  it("does NOT write workflowType when content matches existing 'write' type (no-op)", async () => {
    const existing = makeWorkflow({
      workflowType: "write",
      nodes: [WRITE_CONTRACT_NODE],
    });
    mockWorkflowsFindFirst.mockResolvedValue(existing);
    mockUpdateReturning.mockResolvedValue([
      makeWorkflow({
        workflowType: "write",
        nodes: [WRITE_CONTRACT_NODE],
        description: "updated",
      }),
    ]);

    const response = await PATCH(
      createRequest("PATCH", { description: "updated" }),
      { params: mockParams }
    );

    expect(response.status).toBe(200);
    expect(capturedSet.data?.workflowType).toBeUndefined();
  });
});
