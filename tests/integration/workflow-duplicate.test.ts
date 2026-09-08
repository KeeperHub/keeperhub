import { beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("@/lib/db", () => ({
  db: {
    query: mockDbQuery,
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          where: vi.fn(() => ({ limit: mockMemberLimit })),
        })),
        where: vi.fn(() => ({
          limit: mockMemberLimit,
        })),
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
