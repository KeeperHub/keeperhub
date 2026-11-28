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
  mockUpdateSet,
} = vi.hoisted(() => ({
  mockGetDualAuthContext: vi.fn(),
  mockWorkflowsFindFirst: vi.fn(),
  mockUpdateReturning: vi.fn(),
  mockSelectFrom: vi.fn(),
  mockMemberLimit: vi.fn(),
  mockValidateWorkflowIntegrations: vi.fn(),
  mockSyncWorkflowSchedule: vi.fn(),
  mockUpdateSet: vi.fn(),
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
      set: vi.fn((values: unknown) => {
        mockUpdateSet(values);
        return {
          where: vi.fn(() => ({
            returning: mockUpdateReturning,
          })),
        };
      }),
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

import { GET, PATCH } from "@/app/api/workflows/[workflowId]/route";
import { EOA_NEEDS_EDITOR_MESSAGE } from "@/lib/workflow/validation/action-config";
import { eoaWorkflowLockedMessage } from "@/lib/workflow/validation/eoa-workflow-lock";
import { withoutIgnoredWeb3Connections } from "@/lib/workflow/web3-connection";

function makeRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost:3000/api/workflows/wf-1", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const params = Promise.resolve({ workflowId: "wf-1" });

const TEMPLATE = "{{@webhook:Webhook.flag}}";

// The trigger TEMPLATE reads.
const WEBHOOK = {
  id: "webhook",
  type: "trigger",
  position: { x: 0, y: 0 },
  data: {
    label: "Webhook",
    type: "trigger",
    config: { triggerType: "Webhook" },
  },
};

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
    const stored = existingWorkflow([WEBHOOK, httpNode(failOnError)]);
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
    const response = await PATCH(
      makeRequest({ nodes: [WEBHOOK, httpNode(TEMPLATE)] }),
      {
        params,
      }
    );
    expect(response.status).toBe(200);
  });

  it("compares with a stored node in the old shape, toggle at the data root", async () => {
    const node = httpNode(TEMPLATE) as {
      data: { config: Record<string, unknown> } & Record<string, unknown>;
    };
    const { failOnError, ...config } = node.data.config;
    const stored = existingWorkflow([
      WEBHOOK,
      { ...node, data: { ...node.data, config, failOnError } },
    ]);
    mockWorkflowsFindFirst.mockResolvedValue(stored);
    mockUpdateReturning.mockResolvedValue([stored]);
    const response = await PATCH(
      makeRequest({ nodes: [WEBHOOK, httpNode(TEMPLATE)] }),
      {
        params,
      }
    );
    expect(response.status).toBe(200);
  });

  it("refuses a changed value", async () => {
    storedWith(TEMPLATE);
    const response = await PATCH(
      makeRequest({ nodes: [WEBHOOK, httpNode("{{@webhook:Webhook.other}}")] }),
      { params }
    );
    expect(response.status).toBe(422);
    expect((await response.json()).error).toBe("INVALID_ACTION_CONFIG");
    expect(mockUpdateReturning).not.toHaveBeenCalled();
  });

  it("refuses a new value", async () => {
    storedWith(true);
    const response = await PATCH(
      makeRequest({ nodes: [WEBHOOK, httpNode(TEMPLATE)] }),
      {
        params,
      }
    );
    expect(response.status).toBe(422);
  });
});

describe("PATCH /api/workflows/[workflowId] with a Web3 Connection", () => {
  const TARGET = "0x6B175474E89094C44Da98b954EedeAC495271d0F";

  function step(config: Record<string, unknown>): Record<string, unknown> {
    return {
      id: "step-1",
      type: "action",
      position: { x: 0, y: 0 },
      data: { type: "action", label: "Step", config },
    };
  }

  const WRITE = {
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
  };
  const AAVE = {
    actionType: "aave-v3/supply",
    network: "1",
    asset: TARGET,
    amount: "1",
    onBehalfOf: TARGET,
  };

  function storedConfig(): Record<string, unknown> {
    const { nodes } = mockUpdateSet.mock.calls[0][0] as {
      nodes: { data: { config: Record<string, unknown> } }[];
    };
    return nodes[1].data.config;
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
    const stored = existingWorkflow([WEBHOOK, step(WRITE)]);
    mockWorkflowsFindFirst.mockResolvedValue(stored);
    mockUpdateReturning.mockResolvedValue([stored]);
  });

  it("saves a Safe picked on a Write Contract step", async () => {
    const response = await PATCH(
      makeRequest({
        nodes: [WEBHOOK, step({ ...WRITE, web3Connection: "safe:safe-1" })],
      }),
      { params }
    );
    expect(response.status).toBe(200);
    expect(storedConfig().web3Connection).toBe("safe:safe-1");
  });

  it("refuses a malformed one with a field error", async () => {
    const response = await PATCH(
      makeRequest({
        nodes: [WEBHOOK, step({ ...WRITE, web3Connection: "safe:" })],
      }),
      { params }
    );
    expect(response.status).toBe(422);
    const body = (await response.json()) as { invalidFields: unknown[] };
    expect(body.invalidFields).toEqual([
      expect.objectContaining({
        code: "INVALID_FIELD_VALUE",
        field: "web3Connection",
      }),
    ]);
    expect(mockUpdateSet).not.toHaveBeenCalled();
  });

  it("refuses a Safe on a Batch Write Contract step", async () => {
    const batch = {
      actionType: "web3/batch-write-contract",
      network: "1",
      calls: JSON.stringify([
        { contractAddress: TARGET, abi: WRITE.abi, abiFunction: "run" },
      ]),
    };
    const refused = await PATCH(
      makeRequest({
        nodes: [WEBHOOK, step({ ...batch, web3Connection: "safe:safe-1" })],
      }),
      { params }
    );
    expect(refused.status).toBe(422);
    const body = (await refused.json()) as { invalidFields: unknown[] };
    expect(body.invalidFields).toEqual([
      expect.objectContaining({
        code: "INVALID_FIELD_VALUE",
        field: "web3Connection",
      }),
    ]);
    const saved = await PATCH(
      makeRequest({
        nodes: [WEBHOOK, step({ ...batch, web3Connection: "eoa" })],
      }),
      { params }
    );
    expect(saved.status).toBe(200);
    expect(storedConfig().web3Connection).toBe("eoa");
  });

  it("keeps it on a legacy Write Contract step, which runs the same step", async () => {
    const response = await PATCH(
      makeRequest({
        nodes: [
          WEBHOOK,
          step({
            ...WRITE,
            actionType: "Write Contract",
            web3Connection: "eoa",
          }),
        ],
      }),
      { params }
    );
    expect(response.status).toBe(200);
    expect(storedConfig().web3Connection).toBe("eoa");
  });

  it("saves one picked on a Robinhood Trade Stock Token step", async () => {
    const response = await PATCH(
      makeRequest({
        nodes: [
          WEBHOOK,
          step({
            actionType: "robinhood/trade-stock-token",
            network: "4663",
            symbol: "AAPL",
            side: "buy",
            amountIn: "10",
            minAmountOut: "0.01",
            poolFee: "3000",
            poolTickSpacing: "60",
            web3Connection: "safe:safe-1",
          }),
        ],
      }),
      { params }
    );
    expect(response.status).toBe(200);
    expect(storedConfig().web3Connection).toBe("safe:safe-1");
  });

  function storedAs(nodes: unknown[]): void {
    const stored = existingWorkflow(nodes);
    mockWorkflowsFindFirst.mockResolvedValue(stored);
    mockUpdateReturning.mockResolvedValue([stored]);
  }

  function asApiKey(): void {
    mockGetDualAuthContext.mockResolvedValue({
      userId: "user-1",
      organizationId: "org-1",
      authMethod: "api-key",
      apiKeyId: "key-1",
    });
  }

  it("saves a protocol step without a stored one it would ignore", async () => {
    storedAs([WEBHOOK, step({ ...AAVE, web3Connection: "safe:safe-1" })]);
    const response = await PATCH(
      makeRequest({
        nodes: [WEBHOOK, step({ ...AAVE, web3Connection: "safe:safe-1" })],
      }),
      { params }
    );
    expect(response.status).toBe(200);
    expect(storedConfig()).toEqual(AAVE);
  });

  it("refuses a new one on a protocol step from an API key, naming who sends", async () => {
    asApiKey();
    storedAs([WEBHOOK, step(AAVE)]);
    for (const web3Connection of ["eoa", "safe:safe-1"]) {
      const response = await PATCH(
        makeRequest({ nodes: [WEBHOOK, step({ ...AAVE, web3Connection })] }),
        { params }
      );
      expect(response.status).toBe(422);
      const body = (await response.json()) as {
        invalidFields: { message: string }[];
      };
      expect(body.invalidFields).toEqual([
        expect.objectContaining({
          code: "INVALID_FIELD_VALUE",
          field: "web3Connection",
        }),
      ]);
      expect(body.invalidFields[0].message).toContain(
        "is always sent from your Default Sender (organization policy); remove web3Connection"
      );
    }
    for (const web3Connection of ["", "default", null]) {
      const response = await PATCH(
        makeRequest({ nodes: [WEBHOOK, step({ ...AAVE, web3Connection })] }),
        { params }
      );
      expect(response.status).toBe(200);
    }
    expect(mockUpdateSet).toHaveBeenCalledTimes(3);
  });

  it("drops a new one on a protocol step from the editor", async () => {
    storedAs([WEBHOOK, step(AAVE)]);
    const response = await PATCH(
      makeRequest({
        nodes: [WEBHOOK, step({ ...AAVE, web3Connection: "safe:safe-1" })],
      }),
      { params }
    );
    expect(response.status).toBe(200);
    expect(storedConfig()).toEqual(AAVE);
  });

  it("saves twice from the editor a workflow with a legacy key on Aave", async () => {
    storedAs([WEBHOOK, step({ ...AAVE, web3Connection: "eoa" })]);
    // The open editor still holds the key after the first save strips it.
    const inEditor = [WEBHOOK, step({ ...AAVE, web3Connection: "eoa" })];
    for (const save of [0, 1]) {
      const response = await PATCH(
        makeRequest({ nodes: withoutIgnoredWeb3Connections(inEditor) }),
        { params }
      );
      expect(response.status).toBe(200);
      const { nodes } = mockUpdateSet.mock.calls[save][0] as {
        nodes: unknown[];
      };
      storedAs(nodes);
    }
    expect(storedConfig()).toEqual(AAVE);
  });

  it("refuses a new eoa from an API key", async () => {
    asApiKey();
    const response = await PATCH(
      makeRequest({
        nodes: [WEBHOOK, step({ ...WRITE, web3Connection: "eoa" })],
      }),
      { params }
    );
    expect(response.status).toBe(422);
    const body = (await response.json()) as { invalidFields: unknown[] };
    expect(body.invalidFields).toEqual([
      expect.objectContaining({
        code: "INVALID_FIELD_VALUE",
        field: "web3Connection",
        message: EOA_NEEDS_EDITOR_MESSAGE,
      }),
    ]);
    expect(mockUpdateSet).not.toHaveBeenCalled();
  });

  it("refuses a new eoa from OAuth (MCP)", async () => {
    mockGetDualAuthContext.mockResolvedValue({
      userId: "user-1",
      organizationId: "org-1",
      authMethod: "oauth",
      scope: "mcp:write",
    });
    const response = await PATCH(
      makeRequest({
        nodes: [WEBHOOK, step({ ...WRITE, web3Connection: "eoa" })],
      }),
      { params }
    );
    expect(response.status).toBe(422);
  });

  it("saves a stored eoa unchanged from an API key", async () => {
    asApiKey();
    storedAs([WEBHOOK, step({ ...WRITE, web3Connection: "eoa" })]);
    const response = await PATCH(
      makeRequest({
        nodes: [WEBHOOK, step({ ...WRITE, web3Connection: "eoa" })],
      }),
      { params }
    );
    expect(response.status).toBe(200);
    expect(storedConfig().web3Connection).toBe("eoa");
  });

  it("saves a new eoa from an editor session", async () => {
    const response = await PATCH(
      makeRequest({
        nodes: [WEBHOOK, step({ ...WRITE, web3Connection: "eoa" })],
      }),
      { params }
    );
    expect(response.status).toBe(200);
    expect(storedConfig().web3Connection).toBe("eoa");
  });

  describe("a step that sends from the EOA", () => {
    const TRANSFER = {
      actionType: "web3/transfer-funds",
      network: "1",
      amount: "0.1",
      recipientAddress: TARGET,
    };
    const OTHER = "0x1111111111111111111111111111111111111111";
    const eoaWrite = step({ ...WRITE, web3Connection: "eoa" });

    // Stored nodes, then the nodes the request sends.
    const EDITS: [string, unknown[], unknown[]][] = [
      [
        "changes the contract",
        [WEBHOOK, eoaWrite],
        [
          WEBHOOK,
          step({ ...WRITE, contractAddress: OTHER, web3Connection: "eoa" }),
        ],
      ],
      [
        "changes the action type",
        [WEBHOOK, eoaWrite],
        [WEBHOOK, step({ ...TRANSFER, web3Connection: "eoa" })],
      ],
      [
        "changes the network",
        [WEBHOOK, eoaWrite],
        [WEBHOOK, step({ ...WRITE, network: "8453", web3Connection: "eoa" })],
      ],
      [
        "switches a legacy eoa on Aave to Write Contract",
        [WEBHOOK, step({ ...AAVE, web3Connection: "eoa" })],
        [WEBHOOK, eoaWrite],
      ],
      [
        "sends two steps with the stored id",
        [WEBHOOK, eoaWrite],
        [WEBHOOK, eoaWrite, eoaWrite],
      ],
      [
        "moves a Solana Transfer Native Token to an EVM network",
        [WEBHOOK, step({ ...TRANSFER, network: "101", web3Connection: "eoa" })],
        [WEBHOOK, step({ ...TRANSFER, web3Connection: "eoa" })],
      ],
      [
        "disables the step",
        [WEBHOOK, eoaWrite],
        [
          WEBHOOK,
          {
            ...eoaWrite,
            data: {
              ...(eoaWrite.data as Record<string, unknown>),
              enabled: false,
            },
          },
        ],
      ],
      [
        "moves a config field to the data root",
        [WEBHOOK, eoaWrite],
        [
          WEBHOOK,
          {
            ...eoaWrite,
            data: {
              ...(eoaWrite.data as Record<string, unknown>),
              contractAddress: OTHER,
            },
          },
        ],
      ],
    ];

    it.each(EDITS)(
      "refuses an API key that %s",
      async (_name, stored, sent) => {
        asApiKey();
        storedAs(stored);
        const response = await PATCH(makeRequest({ nodes: sent }), { params });
        expect(response.status).toBe(422);
        const body = (await response.json()) as {
          invalidFields: { field?: string }[];
        };
        expect(body.invalidFields).toContainEqual(
          expect.objectContaining({
            code: "INVALID_FIELD_VALUE",
            field: "web3Connection",
          })
        );
        expect(mockUpdateSet).not.toHaveBeenCalled();
      }
    );

    it.each(EDITS)(
      "saves an editor session that %s",
      async (_name, stored, sent) => {
        storedAs(stored);
        const response = await PATCH(makeRequest({ nodes: sent }), { params });
        expect(response.status).toBe(200);
      }
    );

    it("drops one on a Solana transfer from the editor, and keeps it on EVM", async () => {
      storedAs([WEBHOOK, step({ ...TRANSFER, network: "101" })]);
      const solana = await PATCH(
        makeRequest({
          nodes: [
            WEBHOOK,
            step({ ...TRANSFER, network: "101", web3Connection: "safe:x" }),
          ],
        }),
        { params }
      );
      expect(solana.status).toBe(200);
      expect(storedConfig()).not.toHaveProperty("web3Connection");

      mockUpdateSet.mockClear();
      const evm = await PATCH(
        makeRequest({
          nodes: [WEBHOOK, step({ ...TRANSFER, web3Connection: "safe:x" })],
        }),
        { params }
      );
      expect(evm.status).toBe(200);
      expect(storedConfig().web3Connection).toBe("safe:x");
    });

    it("refuses a new one on a Solana transfer from an API key", async () => {
      asApiKey();
      storedAs([WEBHOOK, step({ ...TRANSFER, network: "101" })]);
      const response = await PATCH(
        makeRequest({
          nodes: [
            WEBHOOK,
            step({ ...TRANSFER, network: "101", web3Connection: "safe:x" }),
          ],
        }),
        { params }
      );
      expect(response.status).toBe(422);
      const body = (await response.json()) as {
        invalidFields: { message: string }[];
      };
      expect(body.invalidFields).toEqual([
        expect.objectContaining({
          field: "web3Connection",
          message: expect.stringContaining(
            "is always sent from your organization's Solana wallet"
          ),
        }),
      ]);
      expect(mockUpdateSet).not.toHaveBeenCalled();
    });

    it("saves a new description on an EOA step from an API key, not a new label", async () => {
      asApiKey();
      storedAs([WEBHOOK, eoaWrite]);
      const data = eoaWrite.data as Record<string, unknown>;
      const described = await PATCH(
        makeRequest({
          nodes: [
            WEBHOOK,
            { ...eoaWrite, data: { ...data, description: "New text" } },
          ],
        }),
        { params }
      );
      expect(described.status).toBe(200);
      const renamed = await PATCH(
        makeRequest({
          nodes: [
            WEBHOOK,
            { ...eoaWrite, data: { ...data, label: "Renamed" } },
          ],
        }),
        { params }
      );
      expect(renamed.status).toBe(422);
    });

    it("saves it from an API key with the keys in another order", async () => {
      asApiKey();
      storedAs([WEBHOOK, eoaWrite]);
      const reordered = Object.fromEntries(
        Object.entries({ ...WRITE, web3Connection: "eoa" }).reverse()
      );
      const response = await PATCH(
        makeRequest({ nodes: [WEBHOOK, step(reordered)] }),
        { params }
      );
      expect(response.status).toBe(200);
      expect(storedConfig().web3Connection).toBe("eoa");
    });

    it("saves a legacy eoa on Aave sent back unchanged by an API key", async () => {
      asApiKey();
      storedAs([WEBHOOK, step({ ...AAVE, web3Connection: "eoa" })]);
      const response = await PATCH(
        makeRequest({
          nodes: [WEBHOOK, step({ ...AAVE, web3Connection: "eoa" })],
        }),
        { params }
      );
      expect(response.status).toBe(200);
      expect(storedConfig()).toEqual(AAVE);
    });
  });

  describe("a workflow with a step that sends from the EOA", () => {
    const OTHER = "0x1111111111111111111111111111111111111111";
    const upstream: Record<string, unknown> = { ...step(WRITE), id: "step-0" };
    const eoaStep = step({ ...WRITE, web3Connection: "eoa" });
    const EDGES = [
      { id: "e1", source: "webhook", target: "step-0" },
      { id: "e2", source: "step-0", target: "step-1" },
    ];
    const NODES = [WEBHOOK, upstream, eoaStep];
    const EXPOSURE_PATHS = new Set([
      "isListed",
      "priceUsdcPerCall",
      "inputSchema",
      "visibility",
    ]);

    function storedWorkflow(
      nodes: unknown[] = NODES,
      extra: Record<string, unknown> = {}
    ): void {
      const stored = { ...existingWorkflow(nodes), edges: EDGES, ...extra };
      mockWorkflowsFindFirst.mockResolvedValue(stored);
      mockUpdateReturning.mockResolvedValue([stored]);
    }

    function withConfig(
      node: Record<string, unknown>,
      config: Record<string, unknown>
    ): Record<string, unknown> {
      const data = node.data as Record<string, unknown>;
      return { ...node, data: { ...data, config } };
    }

    function withData(
      node: Record<string, unknown>,
      fields: Record<string, unknown>
    ): Record<string, unknown> {
      const data = node.data as Record<string, unknown>;
      return { ...node, data: { ...data, ...fields } };
    }

    const changedUpstream = withConfig(upstream, {
      ...WRITE,
      contractAddress: OTHER,
    });
    const toDefault = withConfig(eoaStep, {
      ...WRITE,
      web3Connection: "default",
    });

    // Request body, then the path the refusal points at.
    const LOCKED: [string, Record<string, unknown>, string][] = [
      [
        "changes an upstream node's config",
        { nodes: [WEBHOOK, changedUpstream, eoaStep] },
        "nodes[1]",
      ],
      [
        "renames an upstream node",
        { nodes: [WEBHOOK, withData(upstream, { label: "Renamed" }), eoaStep] },
        "nodes[1]",
      ],
      [
        "changes the trigger",
        {
          nodes: [
            withConfig(WEBHOOK, { triggerType: "Manual" }),
            upstream,
            eoaStep,
          ],
        },
        "nodes[0]",
      ],
      [
        "changes the edges",
        { nodes: NODES, edges: [EDGES[0], { ...EDGES[1], source: "webhook" }] },
        "edges",
      ],
      ["changes only the edges", { edges: [EDGES[0]] }, "edges"],
      [
        "adds a node",
        { nodes: [...NODES, { ...step(WRITE), id: "step-2" }] },
        "nodes[3]",
      ],
      [
        "disables an upstream node",
        { nodes: [WEBHOOK, withData(upstream, { enabled: false }), eoaStep] },
        "nodes[1]",
      ],
      [
        "sets the EOA step to default and changes an upstream node",
        { nodes: [WEBHOOK, changedUpstream, toDefault] },
        "nodes[1]",
      ],
      ["sends nodes that are not an array", { nodes: null }, "nodes"],
      ["lists it", { isListed: true, listedSlug: "eoa-workflow" }, "isListed"],
      ["changes its price", { priceUsdcPerCall: "0.5" }, "priceUsdcPerCall"],
      [
        "changes its input schema",
        { inputSchema: { type: "object" } },
        "inputSchema",
      ],
      ["makes it public", { visibility: "public" }, "visibility"],
    ];

    it.each(LOCKED)("refuses an API key that %s", async (_name, body, path) => {
      asApiKey();
      storedWorkflow();
      const response = await PATCH(makeRequest(body), { params });
      expect(response.status).toBe(422);
      const json = (await response.json()) as {
        invalidFields: { message: string; path: string }[];
      };
      expect(json.invalidFields).toContainEqual(
        expect.objectContaining({
          message: eoaWorkflowLockedMessage(
            ["step-1"],
            EXPOSURE_PATHS.has(path)
          ),
          path,
        })
      );
      expect(mockUpdateSet).not.toHaveBeenCalled();
    });

    it.each(
      LOCKED.filter(
        ([name]) => !(name.includes("not an array") || name === "lists it")
      )
    )("saves an editor session that %s", async (_name, body) => {
      storedWorkflow();
      const response = await PATCH(makeRequest(body), { params });
      expect(response.status).toBe(200);
    });

    it("does not lock listing for an editor session", async () => {
      // Listing has its own publish gates; only the EOA lock is checked here.
      storedWorkflow();
      const response = await PATCH(
        makeRequest({ isListed: true, listedSlug: "eoa-workflow" }),
        { params }
      );
      const json = (await response.json()) as {
        invalidFields?: { message: string }[];
      };
      expect(json.invalidFields ?? []).not.toContainEqual(
        expect.objectContaining({
          message: eoaWorkflowLockedMessage(["step-1"], true),
        })
      );
    });

    const ALLOWED: [string, Record<string, unknown>][] = [
      ["sends it back unchanged", { nodes: NODES, edges: EDGES }],
      [
        "sends it back with keys reordered, moved, a new description and new edge ids",
        {
          nodes: [
            WEBHOOK,
            { ...upstream, position: { x: 50, y: 50 } },
            withConfig(
              withData(eoaStep, { description: "New text" }),
              Object.fromEntries(
                Object.entries({ ...WRITE, web3Connection: "eoa" }).reverse()
              )
            ),
          ],
          edges: [...EDGES].reverse().map((edge) => ({
            ...edge,
            id: `${edge.id}-new`,
            label: "x",
          })),
        },
      ],
      [
        "sets the EOA step to default",
        { nodes: [WEBHOOK, upstream, toDefault] },
      ],
      [
        "sets the EOA step to a Safe",
        {
          nodes: [
            WEBHOOK,
            upstream,
            withConfig(eoaStep, { ...WRITE, web3Connection: "safe:safe-1" }),
          ],
        },
      ],
      [
        "deletes the EOA step and its edge",
        { nodes: [WEBHOOK, upstream], edges: [EDGES[0]] },
      ],
      ["pauses it", { enabled: false }],
      ["enables it", { enabled: true }],
      ["unlists it", { isListed: false }],
      ["makes it private", { visibility: "private" }],
      ["renames the workflow", { name: "New name" }],
    ];

    it.each(ALLOWED)("saves an API key that %s", async (_name, body) => {
      asApiKey();
      storedWorkflow();
      const response = await PATCH(makeRequest(body), { params });
      expect(response.status).toBe(200);
    });

    it("lets an API key remove one of two EOA pins, and nothing more", async () => {
      asApiKey();
      const second = { ...eoaStep, id: "step-2" };
      storedWorkflow([...NODES, second]);
      const removed = await PATCH(
        makeRequest({ nodes: [WEBHOOK, upstream, toDefault, second] }),
        { params }
      );
      expect(removed.status).toBe(200);
      const more = await PATCH(
        makeRequest({ nodes: [WEBHOOK, changedUpstream, toDefault, second] }),
        { params }
      );
      expect(more.status).toBe(422);
    });

    it("lets an API key send back an old Condition node with no rule ids", async () => {
      asApiKey();
      const condition = {
        id: "cond-1",
        type: "action",
        position: { x: 0, y: 0 },
        data: {
          type: "action",
          label: "Check",
          config: {
            actionType: "Condition",
            conditionConfig: {
              group: {
                logic: "AND",
                rules: [
                  { leftOperand: "1", operator: "===", rightOperand: "1" },
                ],
              },
            },
          },
        },
      };
      const nodes = [...NODES, condition];
      storedWorkflow(nodes);
      const response = await PATCH(makeRequest({ nodes, edges: EDGES }), {
        params,
      });
      expect(response.status).toBe(200);
    });
  });
});

describe("GET /api/workflows/[workflowId] public view", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Signed in to a different organization: a public, read-only view.
    mockGetDualAuthContext.mockResolvedValue({
      userId: "user-2",
      organizationId: "org-2",
      authMethod: "session",
    });
    mockSelectFrom.mockResolvedValue([]);
  });

  it("hides the picked sender, like the integration id", async () => {
    const stored = existingWorkflow([
      WEBHOOK,
      {
        id: "step-1",
        type: "action",
        position: { x: 0, y: 0 },
        data: {
          type: "action",
          label: "Step",
          config: {
            actionType: "web3/write-contract",
            integrationId: "int-1",
            web3Connection: "safe:safe-1",
            network: "1",
          },
        },
      },
    ]);
    mockWorkflowsFindFirst.mockResolvedValue({
      ...stored,
      visibility: "public",
    });
    const response = await GET(
      new Request("http://localhost:3000/api/workflows/wf-1"),
      { params }
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      nodes: { data: { config: Record<string, unknown> } }[];
    };
    expect(body.nodes[1].data.config).toEqual({
      actionType: "web3/write-contract",
      network: "1",
    });
  });
});
