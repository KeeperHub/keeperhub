import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildWorkflowExportV1,
  WORKFLOW_EXPORT_VERSION,
} from "@/lib/workflow/export-schema";
import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow/store";

const UNSUPPORTED_VERSION_REGEX = /Unsupported workflow export version/;
const SIGN_IN_TO_IMPORT_REGEX = /Sign in to import/;

const ownerId = "user-export-test";
const orgId = "org-export-test";

const sessionForOwner = {
  user: { id: ownerId, email: "owner@example.com", name: "Owner" },
};

const storedWorkflow = {
  id: "wf-export-1",
  userId: ownerId,
  organizationId: orgId,
  isAnonymous: false,
  name: "My Test Workflow",
  description: "exportable",
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
      position: { x: 200, y: 0 },
      data: {
        label: "Send Discord",
        type: "action",
        config: {
          actionType: "send-discord-message",
          integrationId: "secret-integration-uuid",
          integrationType: "discord",
          message: "hi",
        },
        status: "idle",
      },
    },
    // A leftover UI placeholder. The export must drop this and any edges
    // referencing it.
    {
      id: "add-1",
      type: "action",
      position: { x: 400, y: 0 },
      data: {
        label: "Add Step",
        type: "add",
        status: "idle",
      },
    },
  ],
  edges: [
    { id: "e1", source: "trigger-1", target: "action-1", type: "animated" },
    { id: "e2", source: "action-1", target: "add-1", type: "animated" },
  ],
  createdAt: new Date(),
  updatedAt: new Date(),
};

const validImportActionNode = {
  id: "action-1",
  type: "action",
  position: { x: 200, y: 0 },
  data: {
    label: "Send Webhook",
    type: "action",
    config: {
      actionType: "webhook/send-webhook",
      webhookUrl: "https://example.com/webhook",
      webhookMethod: "POST",
    },
    status: "idle",
  },
};

const insertedRows: Record<string, unknown>[] = [];

const mockDbQuery = {
  workflows: {
    findFirst: vi.fn(),
  },
};

const mockMemberLimit = vi.fn();
const mockIncrementCounter = vi.fn();

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
      values: vi.fn().mockImplementation((v: Record<string, unknown>) => ({
        returning: vi.fn().mockImplementation(() => {
          const row = {
            ...v,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          insertedRows.push(row);
          return Promise.resolve([row]);
        }),
      })),
    }),
    // The route registers the imported schedule after the insert; a non-schedule
    // import takes the delete branch of syncWorkflowSchedule.
    delete: vi.fn(() => ({
      where: vi.fn().mockResolvedValue(undefined),
    })),
  },
}));

vi.mock("@/lib/db/integrations", () => ({
  validateWorkflowIntegrations: vi.fn().mockResolvedValue({ valid: true }),
}));

vi.mock("@/lib/features/route-guard", () => ({
  enforceWorkflowFeatures: vi.fn().mockResolvedValue({ blocked: false }),
  FEATURE_UPGRADE_REQUIRED_ERROR:
    "This workflow uses features that require a paid plan.",
}));

vi.mock("@/lib/auth", () => ({
  auth: {
    api: {
      getSession: vi.fn().mockResolvedValue(sessionForOwner),
    },
  },
}));

vi.mock("@/lib/middleware/auth-helpers", () => ({
  getDualAuthContext: vi.fn().mockResolvedValue({
    userId: ownerId,
    organizationId: orgId,
    authMethod: "session",
    apiKeyId: null,
    isAnonymous: false,
  }),
  auditFromAuth: vi.fn().mockReturnValue({ authMethod: "session" }),
  authFailureResponse: (
    failure: { error: string; code: string; status: number },
    _headers: Headers
  ) =>
    NextResponse.json(
      { error: failure.code, detail: failure.error, request_id: "test" },
      { status: failure.status }
    ),
  UNAUTHENTICATED_AUDIT: { authMethod: "unknown" },
}));

vi.mock("@/lib/middleware/org-context", () => ({
  getOrgContext: vi.fn().mockResolvedValue({
    organization: { id: orgId },
    isAnonymous: false,
  }),
}));

vi.mock("@/lib/metrics", () => ({
  getMetricsCollector: () => ({
    incrementCounter: mockIncrementCounter,
    recordHistogram: vi.fn(),
    setGauge: vi.fn(),
    recordError: vi.fn(),
  }),
}));

describe("GET /api/workflows/[workflowId]/download", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insertedRows.length = 0;
    mockDbQuery.workflows.findFirst.mockResolvedValue(storedWorkflow);
    mockMemberLimit.mockResolvedValue([{ id: "member-1" }]);
  });

  it("returns a v1 JSON export attachment for the owner", async () => {
    const { GET } = await import(
      "@/app/api/workflows/[workflowId]/download/route"
    );

    const request = new Request(
      "http://localhost/api/workflows/wf-export-1/download"
    );
    const response = await GET(request, {
      params: Promise.resolve({ workflowId: "wf-export-1" }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    const disposition = response.headers.get("Content-Disposition") ?? "";
    expect(disposition).toContain("attachment");
    expect(disposition).toContain('filename="my-test-workflow.workflow.json"');
    expect(disposition).toContain(
      "filename*=UTF-8''my-test-workflow.workflow.json"
    );

    const body = await response.json();
    expect(body.version).toBe(WORKFLOW_EXPORT_VERSION);
    expect(body.workflow).toEqual({
      name: "My Test Workflow",
      description: "exportable",
    });

    // integrationId is stripped, integrationType is recorded as a binding.
    const action = body.nodes.find((n: { id: string }) => n.id === "action-1");
    expect(action.data.config.integrationId).toBeUndefined();
    expect(action.data.config.actionType).toBe("send-discord-message");
    expect(body.integrationBindings).toEqual([
      { nodeId: "action-1", integrationType: "discord" },
    ]);

    // "add" placeholder node and its edge are filtered out.
    expect(body.nodes.map((n: { id: string }) => n.id)).not.toContain("add-1");
    expect(body.edges.map((e: { id: string }) => e.id)).not.toContain("e2");

    expect(mockIncrementCounter).toHaveBeenCalledWith("workflow.exports.total");
  });

  it("does not increment the export counter on a 404", async () => {
    mockDbQuery.workflows.findFirst.mockResolvedValue({
      ...storedWorkflow,
      userId: "someone-else",
      organizationId: "other-org",
    });

    const { GET } = await import(
      "@/app/api/workflows/[workflowId]/download/route"
    );
    const request = new Request(
      "http://localhost/api/workflows/wf-export-1/download"
    );
    const response = await GET(request, {
      params: Promise.resolve({ workflowId: "wf-export-1" }),
    });

    expect(response.status).toBe(404);
    expect(mockIncrementCounter).not.toHaveBeenCalledWith(
      "workflow.exports.total"
    );
  });

  it("returns 404 when the caller does not own the workflow and is not in the org", async () => {
    mockDbQuery.workflows.findFirst.mockResolvedValue({
      ...storedWorkflow,
      userId: "someone-else",
      organizationId: "other-org",
    });

    const { GET } = await import(
      "@/app/api/workflows/[workflowId]/download/route"
    );
    const request = new Request(
      "http://localhost/api/workflows/wf-export-1/download"
    );
    const response = await GET(request, {
      params: Promise.resolve({ workflowId: "wf-export-1" }),
    });

    expect(response.status).toBe(404);
  });

  it("returns 401 when getDualAuthContext rejects the request", async () => {
    const { getDualAuthContext } = await import(
      "@/lib/middleware/auth-helpers"
    );
    vi.mocked(getDualAuthContext).mockResolvedValueOnce({
      error: "Unauthorized",
      code: "unauthorized",
      status: 401,
    });

    const { GET } = await import(
      "@/app/api/workflows/[workflowId]/download/route"
    );
    const request = new Request(
      "http://localhost/api/workflows/wf-export-1/download"
    );
    const response = await GET(request, {
      params: Promise.resolve({ workflowId: "wf-export-1" }),
    });

    expect(response.status).toBe(401);
  });
});

describe("POST /api/workflows/import", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insertedRows.length = 0;
    mockDbQuery.workflows.findFirst.mockResolvedValue(storedWorkflow);
    mockMemberLimit.mockResolvedValue([{ id: "member-1" }]);
  });

  it("creates a new workflow row owned by the caller", async () => {
    const exportPayload = buildWorkflowExportV1({
      name: "imported wf",
      description: "imported description",
      nodes: [
        storedWorkflow.nodes[0] as unknown as WorkflowNode,
        validImportActionNode as unknown as WorkflowNode,
      ],
      edges: storedWorkflow.edges.slice(0, 1) as WorkflowEdge[],
    });

    const { POST } = await import("@/app/api/workflows/import/route");
    const request = new Request("http://localhost/api/workflows/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(exportPayload),
    });
    const response = await POST(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.userId).toBe(ownerId);
    expect(body.organizationId).toBe(orgId);
    expect(body.name).toBe("imported wf");
    expect(body.integrationBindings).toEqual(exportPayload.integrationBindings);

    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0].userId).toBe(ownerId);
    expect(insertedRows[0].organizationId).toBe(orgId);

    expect(mockIncrementCounter).toHaveBeenCalledWith("workflow.imports.total");
  });

  it("rejects invalid action configs before importing workflow", async () => {
    const exportPayload = buildWorkflowExportV1({
      name: "invalid import",
      description: null,
      nodes: [
        storedWorkflow.nodes[0],
        {
          ...validImportActionNode,
          data: {
            ...validImportActionNode.data,
            config: {
              actionType: "discord/send-message",
              Message: "hello",
            },
          },
        },
      ] as WorkflowNode[],
      edges: storedWorkflow.edges.slice(0, 1) as WorkflowEdge[],
    });

    const { POST } = await import("@/app/api/workflows/import/route");
    const request = new Request("http://localhost/api/workflows/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(exportPayload),
    });
    const response = await POST(request);

    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.error).toBe("INVALID_ACTION_CONFIG");
    expect(insertedRows).toHaveLength(0);
    expect(mockIncrementCounter).not.toHaveBeenCalledWith(
      "workflow.imports.total"
    );
  });

  it("rejects an unsupported version", async () => {
    const exportPayload = buildWorkflowExportV1({
      name: "x",
      description: null,
      nodes: storedWorkflow.nodes.filter(
        (n) => n.data.type !== "add"
      ) as WorkflowNode[],
      edges: [],
    });

    const tampered = { ...exportPayload, version: 99 };

    const { POST } = await import("@/app/api/workflows/import/route");
    const request = new Request("http://localhost/api/workflows/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(tampered),
    });
    const response = await POST(request);

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(UNSUPPORTED_VERSION_REGEX);
    expect(insertedRows).toHaveLength(0);
  });

  it("rejects a body that is not a JSON object", async () => {
    const { POST } = await import("@/app/api/workflows/import/route");
    const request = new Request("http://localhost/api/workflows/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify("not an object"),
    });
    const response = await POST(request);

    expect(response.status).toBe(400);
    expect(insertedRows).toHaveLength(0);
  });

  it("rejects a payload whose integrationBindings reference unknown nodes", async () => {
    const exportPayload = buildWorkflowExportV1({
      name: "x",
      description: null,
      nodes: storedWorkflow.nodes.filter(
        (n) => n.data.type !== "add"
      ) as WorkflowNode[],
      edges: [],
    });

    const tampered = {
      ...exportPayload,
      integrationBindings: [
        { nodeId: "ghost-node", integrationType: "discord" },
      ],
    };

    const { POST } = await import("@/app/api/workflows/import/route");
    const request = new Request("http://localhost/api/workflows/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(tampered),
    });
    const response = await POST(request);

    expect(response.status).toBe(400);
    expect(insertedRows).toHaveLength(0);
    expect(mockIncrementCounter).not.toHaveBeenCalledWith(
      "workflow.imports.total"
    );
  });

  it("rejects a payload that fails strict schema validation", async () => {
    const malformed = {
      version: WORKFLOW_EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      workflow: { name: "x" },
      // nodes/edges/integrationBindings missing entirely
    };

    const { POST } = await import("@/app/api/workflows/import/route");
    const request = new Request("http://localhost/api/workflows/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(malformed),
    });
    const response = await POST(request);

    expect(response.status).toBe(400);
    expect(insertedRows).toHaveLength(0);
  });

  it("returns 403 for an anonymous session", async () => {
    const { auth } = await import("@/lib/auth");
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: ownerId, email: "temp-abc@http://anon", name: "Anonymous" },
    } as Awaited<ReturnType<typeof auth.api.getSession>>);

    const exportPayload = buildWorkflowExportV1({
      name: "x",
      description: null,
      nodes: storedWorkflow.nodes.filter(
        (n) => n.data.type !== "add"
      ) as WorkflowNode[],
      edges: [],
    });

    const { POST } = await import("@/app/api/workflows/import/route");
    const request = new Request("http://localhost/api/workflows/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(exportPayload),
    });
    const response = await POST(request);

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toMatch(SIGN_IN_TO_IMPORT_REGEX);
    expect(insertedRows).toHaveLength(0);
    expect(mockIncrementCounter).not.toHaveBeenCalledWith(
      "workflow.imports.total"
    );
  });

  it("returns 401 when getDualAuthContext yields no userId", async () => {
    const { getDualAuthContext } = await import(
      "@/lib/middleware/auth-helpers"
    );
    vi.mocked(getDualAuthContext).mockResolvedValueOnce({
      userId: null,
      organizationId: null,
      authMethod: "session",
      apiKeyId: null,
      isAnonymous: false,
    });

    const exportPayload = buildWorkflowExportV1({
      name: "x",
      description: null,
      nodes: storedWorkflow.nodes.filter(
        (n) => n.data.type !== "add"
      ) as WorkflowNode[],
      edges: [],
    });

    const { POST } = await import("@/app/api/workflows/import/route");
    const request = new Request("http://localhost/api/workflows/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(exportPayload),
    });
    const response = await POST(request);

    expect(response.status).toBe(401);
    expect(insertedRows).toHaveLength(0);
  });
});
