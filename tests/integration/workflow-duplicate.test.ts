import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SENDER_NOT_CHOSEN } from "@/lib/safe/sender-not-chosen";

const mockSession = {
  user: { id: "user-dup-test", email: "test@example.com", name: "Test User" },
};

const sourceWorkflow = {
  id: "source-wf-1",
  userId: "other-user",
  name: "Source Workflow",
  description: "Has template refs",
  visibility: "public" as const,
  organizationId: "org-1",
  isAnonymous: false,
  nodes: [
    {
      id: "trigger-1",
      type: "trigger",
      position: { x: 0, y: 0 },
      data: {
        label: "Manual Trigger",
        type: "trigger",
        config: { triggerType: "Manual" },
        status: "idle",
      },
    },
    {
      id: "action-1",
      type: "action",
      position: { x: 0, y: 100 },
      data: {
        label: "Condition",
        type: "action",
        config: {
          actionType: "Condition",
          condition: "{{@trigger-1:Manual Trigger.value}} > 100",
        },
        status: "idle",
      },
    },
  ],
  edges: [{ id: "e1", source: "trigger-1", target: "action-1" }],
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockDbQuery = {
  workflows: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
  },
};

const mockDbDelete = vi.fn().mockResolvedValue(undefined);
const mockMemberLimit = vi.fn();
// The copier organization's Safes among those the copied steps name.
const mockOwnedSafes = vi.fn();
// The condition the Safe lookup filters by.
const mockSafeWhere = vi.fn();
const isSafeWallets = (table: unknown): boolean =>
  (table as Record<symbol, unknown> | undefined)?.[
    Symbol.for("drizzle:Name")
  ] === "safe_wallets";

vi.mock("@/lib/db", () => ({
  db: {
    query: mockDbQuery,
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        innerJoin: vi.fn(() => ({
          where: vi.fn(() => ({ limit: mockMemberLimit })),
        })),
        leftJoin: vi.fn(() => ({
          where: vi.fn(() => ({ limit: mockMemberLimit })),
        })),
        where: vi.fn((condition: unknown) => {
          if (isSafeWallets(table)) {
            mockSafeWhere(condition);
            return { limit: mockOwnedSafes };
          }
          return { limit: mockMemberLimit };
        }),
      })),
    })),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockImplementation((v: unknown) => ({
        returning: vi.fn().mockResolvedValue([
          {
            ...(v as object),
            id: "new-wf-id",
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ]),
      })),
    }),
    delete: vi.fn().mockReturnValue({ where: mockDbDelete }),
  },
}));

vi.mock("@/lib/auth", () => ({
  auth: {
    api: {
      getSession: vi.fn().mockResolvedValue(mockSession),
    },
  },
}));

vi.mock("@/lib/middleware/org-context", () => ({
  getOrgContext: vi.fn().mockResolvedValue({
    organization: { id: "org-1" },
    isAnonymous: false,
  }),
}));

vi.mock("@/lib/features/route-guard", () => ({
  enforceWorkflowFeatures: vi.fn().mockResolvedValue({ blocked: false }),
  FEATURE_UPGRADE_REQUIRED_ERROR:
    "This workflow uses features that require a paid plan.",
}));

const workflowWithArrayConfig = {
  ...sourceWorkflow,
  id: "source-wf-array",
  nodes: [
    {
      id: "trigger-1",
      type: "trigger",
      position: { x: 0, y: 0 },
      data: {
        label: "Manual Trigger",
        type: "trigger",
        config: { triggerType: "Manual" },
        status: "idle",
      },
    },
    {
      id: "action-1",
      type: "action",
      position: { x: 0, y: 100 },
      data: {
        label: "Multi Input",
        type: "action",
        config: {
          actionType: "MultiInput",
          inputs: [
            "{{@trigger-1:Manual Trigger.value}}",
            "static value",
            "{{@trigger-1:Manual Trigger.other}}",
          ],
          nested: {
            refs: ["{{@trigger-1:Manual Trigger.nested}}"],
          },
        },
        status: "idle",
      },
    },
  ],
};

describe("Workflow duplicate API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.workflows.findFirst.mockResolvedValue(sourceWorkflow);
    mockDbQuery.workflows.findMany.mockResolvedValue([]);
    mockMemberLimit.mockResolvedValue([{ id: "member-1" }]);
  });

  it("duplicates workflow and remaps template references to new node IDs", async () => {
    const { POST } = await import(
      "@/app/api/workflows/[workflowId]/duplicate/route"
    );
    const request = new Request(
      "http://localhost/api/workflows/source-wf-1/duplicate",
      {
        method: "POST",
      }
    );
    const response = await POST(request, {
      params: Promise.resolve({ workflowId: "source-wf-1" }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();

    const nodeIds = body.nodes.map((n: { id: string }) => n.id);
    expect(nodeIds).not.toContain("trigger-1");
    expect(nodeIds).not.toContain("action-1");

    const conditionNode = body.nodes.find(
      (n: { data?: { config?: { condition?: string } } }) =>
        n.data?.config?.condition
    );
    const condition = conditionNode?.data?.config?.condition as string;
    const triggerNode = body.nodes.find(
      (n: { data?: { type: string } }) => n.data?.type === "trigger"
    );
    expect(triggerNode).toBeDefined();
    expect(condition).toContain(triggerNode.id);
    expect(condition).not.toContain("trigger-1");

    expect(body.edges).toHaveLength(1);
    expect(nodeIds).toContain(body.edges[0].source);
    expect(nodeIds).toContain(body.edges[0].target);
  });

  // Pins the invariant the MCP deploy_template annotation rests on. That tool
  // is annotated destructiveHint: false on the grounds that a cloned workflow
  // is inert until a separate call arms it, which is true only because this
  // insert omits `enabled` and the column defaults false in lib/db/schema.ts.
  // Nothing else couples the two: if this route ever starts arming the clone,
  // the annotation silently becomes a promise that a deploy_template call is
  // safe to auto-approve when it can immediately start executing. Breaking
  // here is the loud version of that.
  it("blocks duplicating a paid node, including a malformed one, when the plan gate rejects it", async () => {
    const { enforceWorkflowFeatures } = await import(
      "@/lib/features/route-guard"
    );
    const blockedResponse = new Response(null, { status: 403 });
    vi.mocked(enforceWorkflowFeatures).mockResolvedValueOnce({
      blocked: true,
      response: blockedResponse as never,
      violations: [],
    });
    mockDbQuery.workflows.findFirst.mockResolvedValue({
      ...sourceWorkflow,
      nodes: [
        sourceWorkflow.nodes[0],
        {
          id: "action-1",
          type: "action",
          position: { x: 0, y: 100 },
          data: {
            label: "Code",
            type: "action",
            config: { actionType: ["code/run-code"], code: "return 1;" },
            status: "idle",
          },
        },
      ],
    });
    const { db } = await import("@/lib/db");
    const { POST } = await import(
      "@/app/api/workflows/[workflowId]/duplicate/route"
    );

    const response = await POST(
      new Request("http://localhost/api/workflows/source-wf-1/duplicate", {
        method: "POST",
      }),
      { params: Promise.resolve({ workflowId: "source-wf-1" }) }
    );

    expect(response.status).toBe(403);
    expect(vi.mocked(enforceWorkflowFeatures).mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ actionType: "code/run-code" }),
      ])
    );
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("creates the clone disabled so deploy_template stays non-destructive", async () => {
    const { POST } = await import(
      "@/app/api/workflows/[workflowId]/duplicate/route"
    );
    const request = new Request(
      "http://localhost/api/workflows/source-wf-1/duplicate",
      { method: "POST" }
    );
    const response = await POST(request, {
      params: Promise.resolve({ workflowId: "source-wf-1" }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();

    // The db mock echoes the inserted values straight back, so an absent key
    // here means the route never set it and the schema default (false) stands.
    expect(body.enabled).toBeUndefined();
  });

  it("remaps template references inside arrays in config", async () => {
    mockDbQuery.workflows.findFirst.mockResolvedValue(workflowWithArrayConfig);

    const { POST } = await import(
      "@/app/api/workflows/[workflowId]/duplicate/route"
    );
    const request = new Request(
      "http://localhost/api/workflows/source-wf-array/duplicate",
      { method: "POST" }
    );
    const response = await POST(request, {
      params: Promise.resolve({ workflowId: "source-wf-array" }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();

    const triggerNode = body.nodes.find(
      (n: { data?: { type: string } }) => n.data?.type === "trigger"
    );
    const actionNode = body.nodes.find(
      (n: { data?: { label: string } }) => n.data?.label === "Multi Input"
    );

    expect(triggerNode).toBeDefined();
    expect(actionNode).toBeDefined();

    const { inputs, nested } = actionNode.data.config as {
      inputs: string[];
      nested: { refs: string[] };
    };

    expect(inputs[0]).toContain(triggerNode.id);
    expect(inputs[0]).not.toContain("trigger-1");
    expect(inputs[1]).toBe("static value");
    expect(inputs[2]).toContain(triggerNode.id);
    expect(inputs[2]).not.toContain("trigger-1");

    expect(nested.refs[0]).toContain(triggerNode.id);
    expect(nested.refs[0]).not.toContain("trigger-1");
  });
});

describe("Workflow duplicate API with a stray toggle value", () => {
  const TEMPLATE = "{{@trigger-1:Manual Trigger.flag}}";
  const withStray = (organizationId: string) => ({
    ...sourceWorkflow,
    organizationId,
    nodes: [
      sourceWorkflow.nodes[0],
      {
        id: "http-1",
        type: "action",
        position: { x: 0, y: 100 },
        data: {
          label: "Fetch",
          type: "action",
          config: {
            actionType: "HTTP Request",
            endpoint: "https://example.com",
            httpMethod: "GET",
            failOnError: TEMPLATE,
          },
          status: "idle",
        },
      },
    ],
  });

  async function duplicate(): Promise<Record<string, unknown>> {
    const { POST } = await import(
      "@/app/api/workflows/[workflowId]/duplicate/route"
    );
    const response = await POST(
      new Request("http://localhost/api/workflows/source-wf-1/duplicate", {
        method: "POST",
      }),
      { params: Promise.resolve({ workflowId: "source-wf-1" }) }
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    const http = body.nodes.find(
      (node: { data?: { config?: { actionType?: string } } }) =>
        node.data?.config?.actionType === "HTTP Request"
    );
    return http.data.config;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.workflows.findMany.mockResolvedValue([]);
    mockMemberLimit.mockResolvedValue([{ id: "member-1" }]);
  });

  it("unsets it in a copy of another organization's workflow", async () => {
    mockDbQuery.workflows.findFirst.mockResolvedValue(withStray("org-other"));
    const config = await duplicate();
    expect(config).not.toHaveProperty("failOnError");
    expect(config.endpoint).toBe("https://example.com");
  });

  it("keeps it in a copy within the same organization", async () => {
    mockDbQuery.workflows.findFirst.mockResolvedValue(withStray("org-1"));
    // Kept, with the reference remapped to the copy's node ids.
    const kept = (await duplicate()).failOnError;
    expect(kept).toMatch(/^\{\{@.+:Manual Trigger\.flag\}\}$/);
    expect(kept).not.toBe(TEMPLATE);
  });
});

describe("Workflow duplicate API with a step sending through a Safe", () => {
  const withSafe = (organizationId: string) => ({
    ...sourceWorkflow,
    organizationId,
    nodes: [
      sourceWorkflow.nodes[0],
      {
        id: "swap-1",
        type: "action",
        position: { x: 0, y: 100 },
        data: {
          label: "Swap USDC",
          type: "action",
          config: {
            actionType: "web3/transfer-funds",
            network: "1",
            web3Connection: "safe:their-safe",
          },
          status: "idle",
        },
      },
      {
        id: "eoa-1",
        type: "action",
        position: { x: 0, y: 200 },
        data: {
          label: "Top up",
          type: "action",
          config: {
            actionType: "web3/transfer-funds",
            network: "1",
            web3Connection: "eoa",
          },
          status: "idle",
        },
      },
    ],
  });

  type Copy = {
    nodes: Array<{
      id: string;
      data: { label: string; config: Record<string, unknown> };
    }>;
    stepsNeedingSender: Array<{ nodeId: string; label: string }>;
  };

  async function duplicate(): Promise<Copy> {
    const { POST } = await import(
      "@/app/api/workflows/[workflowId]/duplicate/route"
    );
    const response = await POST(
      new Request("http://localhost/api/workflows/source-wf-1/duplicate", {
        method: "POST",
      }),
      { params: Promise.resolve({ workflowId: "source-wf-1" }) }
    );
    expect(response.status).toBe(200);
    return (await response.json()) as Copy;
  }

  const connectionOf = (copy: Copy, label: string): unknown =>
    copy.nodes.find((node) => node.data.label === label)?.data.config
      .web3Connection;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.workflows.findMany.mockResolvedValue([]);
    mockMemberLimit.mockResolvedValue([{ id: "member-1" }]);
    mockOwnedSafes.mockResolvedValue([]);
  });

  it("leaves a step on a Safe the copier's organization does not own with no sender", async () => {
    mockDbQuery.workflows.findFirst.mockResolvedValue(withSafe("org-other"));
    const copy = await duplicate();

    expect(connectionOf(copy, "Swap USDC")).toBe(SENDER_NOT_CHOSEN);
    // An EOA pick is dropped, so the copier's own policy applies.
    expect(connectionOf(copy, "Top up")).toBeUndefined();
    // The response names the step by the copy's own node id.
    const swap = copy.nodes.find((node) => node.data.label === "Swap USDC");
    expect(swap?.id).not.toBe("swap-1");
    expect(copy.stepsNeedingSender).toEqual([
      { nodeId: swap?.id, label: "Swap USDC" },
    ]);
    // Only the Safes the steps name are looked up, at most one row each.
    expect(mockOwnedSafes).toHaveBeenCalledWith(1);
  });

  it("keeps a Safe the copier's organization owns", async () => {
    mockDbQuery.workflows.findFirst.mockResolvedValue(withSafe("org-other"));
    mockOwnedSafes.mockResolvedValue([{ id: "their-safe" }]);
    const copy = await duplicate();

    expect(connectionOf(copy, "Swap USDC")).toBe("safe:their-safe");
    expect(copy.stepsNeedingSender).toEqual([]);
  });

  it("keeps the Safe in a copy within the same organization, without a lookup", async () => {
    mockDbQuery.workflows.findFirst.mockResolvedValue(withSafe("org-1"));
    const copy = await duplicate();

    expect(connectionOf(copy, "Swap USDC")).toBe("safe:their-safe");
    expect(copy.stepsNeedingSender).toEqual([]);
    expect(mockOwnedSafes).not.toHaveBeenCalled();
  });

  const withExtraStep = (
    organizationId: string,
    label: string,
    config: Record<string, unknown>
  ) => {
    const source = withSafe(organizationId);
    return {
      ...source,
      nodes: [
        ...source.nodes,
        {
          id: "extra-1",
          type: "action",
          position: { x: 0, y: 300 },
          data: { label, type: "action", config, status: "idle" },
        },
      ],
    };
  };

  it("drops a protocol step's Safe instead of marking it, since runs ignore it", async () => {
    mockDbQuery.workflows.findFirst.mockResolvedValue(
      withExtraStep("org-other", "Supply USDC", {
        actionType: "aave-v3/supply",
        network: "1",
        web3Connection: "safe:their-safe",
      })
    );
    const copy = await duplicate();

    const supply = copy.nodes.find((node) => node.data.label === "Supply USDC");
    expect(supply?.data.config).not.toHaveProperty("web3Connection");
    expect(copy.stepsNeedingSender.map((step) => step.label)).toEqual([
      "Swap USDC",
    ]);
  });

  it("drops a Solana transfer's Safe instead of marking it, and does not list it", async () => {
    mockDbQuery.workflows.findFirst.mockResolvedValue(
      withExtraStep("org-other", "Pay in SOL", {
        actionType: "web3/transfer-funds",
        network: "101",
        web3Connection: "safe:their-safe",
      })
    );
    const copy = await duplicate();

    const sol = copy.nodes.find((node) => node.data.label === "Pay in SOL");
    expect(sol?.data.config).not.toHaveProperty("web3Connection");
    expect(copy.stepsNeedingSender.map((step) => step.label)).toEqual([
      "Swap USDC",
    ]);
  });

  it("drops a Batch step's Safe instead of marking it", async () => {
    mockDbQuery.workflows.findFirst.mockResolvedValue(
      withExtraStep("org-other", "Batch calls", {
        actionType: "web3/batch-write-contract",
        network: "1",
        web3Connection: "safe:their-safe",
      })
    );
    const copy = await duplicate();

    const batch = copy.nodes.find((node) => node.data.label === "Batch calls");
    expect(batch?.data.config).not.toHaveProperty("web3Connection");
    expect(copy.stepsNeedingSender.map((step) => step.label)).toEqual([
      "Swap USDC",
    ]);
  });

  it("drops a protocol step's value in a same-organization copy too", async () => {
    mockDbQuery.workflows.findFirst.mockResolvedValue(
      withExtraStep("org-1", "Supply USDC", {
        actionType: "aave-v3/supply",
        network: "1",
        web3Connection: "eoa",
      })
    );
    const copy = await duplicate();

    const supply = copy.nodes.find((node) => node.data.label === "Supply USDC");
    expect(supply?.data.config).not.toHaveProperty("web3Connection");
    expect(connectionOf(copy, "Top up")).toBe("eoa");
  });

  it("names a same-organization copy's steps that already had no sender", async () => {
    mockDbQuery.workflows.findFirst.mockResolvedValue(
      withExtraStep("org-1", "Pay rent", {
        actionType: "web3/transfer-funds",
        network: "1",
        web3Connection: SENDER_NOT_CHOSEN,
      })
    );
    const copy = await duplicate();

    const rent = copy.nodes.find((node) => node.data.label === "Pay rent");
    expect(copy.stepsNeedingSender).toEqual([
      { nodeId: rent?.id, label: "Pay rent" },
    ]);
    expect(connectionOf(copy, "Swap USDC")).toBe("safe:their-safe");
    expect(mockOwnedSafes).not.toHaveBeenCalled();
  });

  it("looks up only the copier organization's Safes", async () => {
    mockDbQuery.workflows.findFirst.mockResolvedValue(withSafe("org-other"));
    await duplicate();

    const [condition] = mockSafeWhere.mock.calls[0] as [SQL];
    const { sql, params } = new PgDialect().sqlToQuery(condition);
    expect(sql).toContain('"safe_wallets"."organization_id" = $');
    expect(sql).toContain('"safe_wallets"."id" in ($');
    // The copier's organization, never the source's.
    expect(params).toContain("org-1");
    expect(params).not.toContain("org-other");
    expect(params).toContain("their-safe");
  });

  it("stores the step with no sender in the copy it creates", async () => {
    mockDbQuery.workflows.findFirst.mockResolvedValue(withSafe("org-other"));
    const { db } = await import("@/lib/db");
    await duplicate();

    const values = vi.mocked(db.insert).mock.results[0]?.value as {
      values: ReturnType<typeof vi.fn>;
    };
    const inserted = values.values.mock.calls[0]?.[0] as Copy;
    expect(
      inserted.nodes.map((node) => node.data.config.web3Connection)
    ).toEqual([undefined, SENDER_NOT_CHOSEN, undefined]);
  });
});
