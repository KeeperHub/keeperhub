import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const WORKFLOW_ID = "wf-123";
const OWNER_USER_ID = "user-owner";
const STRANGER_USER_ID = "user-stranger";
const ORG_ID = "org-1";
const OTHER_ORG_ID = "org-2";

const { mockGetDualAuthContext, mockMemberLimit, mockWorkflowsFindFirst } =
  vi.hoisted(() => ({
    mockGetDualAuthContext: vi.fn(),
    mockMemberLimit: vi.fn(),
    mockWorkflowsFindFirst: vi.fn(),
  }));

vi.mock("@/lib/middleware/auth-helpers", () => ({
  getDualAuthContext: mockGetDualAuthContext,
  // Mirrors the real helper's envelope shape; importing the module itself
  // would pull in lib/auth, which this suite deliberately does not load.
  authFailureResponse: (failure: {
    error: string;
    code: string;
    status: number;
  }): Response =>
    Response.json(
      { error: failure.code, detail: failure.error, request_id: "test" },
      { status: failure.status }
    ),
  UNAUTHENTICATED_AUDIT: { authMethod: "unknown" },
  auditFromAuth: (ctx: unknown): Record<string, string> => {
    if (ctx && typeof ctx === "object" && "error" in ctx) {
      return { authMethod: "unknown" };
    }
    const c = ctx as { authMethod: string; apiKeyId?: string | null };
    return c.apiKeyId
      ? { authMethod: c.authMethod, apiKeyId: c.apiKeyId }
      : { authMethod: c.authMethod };
  },
}));

vi.mock("@/lib/db", () => ({
  db: {
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
    query: {
      workflows: { findFirst: mockWorkflowsFindFirst },
    },
  },
}));

vi.mock("@/lib/db/schema", () => ({
  member: { id: "id", organizationId: "organizationId", userId: "userId" },
  users: { id: "id", deactivatedAt: "deactivated_at" },
  workflows: { id: "id" },
}));

vi.mock("@/lib/workflow-codegen-sdk", () => ({
  generateWorkflowSDKCode: vi.fn(() => "// generated"),
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { DATABASE: "DATABASE" },
  logSystemError: vi.fn(),
}));

import { GET } from "@/app/api/workflows/[workflowId]/code/route";

function buildRequest(): Request {
  return new Request(`http://localhost/api/workflows/${WORKFLOW_ID}/code`);
}

function buildContext(): { params: Promise<{ workflowId: string }> } {
  return { params: Promise.resolve({ workflowId: WORKFLOW_ID }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockMemberLimit.mockResolvedValue([]);
});

describe("GET /api/workflows/[id]/code", () => {
  it("returns 401 when unauthenticated", async () => {
    mockGetDualAuthContext.mockResolvedValue({
      error: "Unauthorized",
      status: 401,
    });

    const response = await GET(buildRequest(), buildContext());
    expect(response.status).toBe(401);
  });

  it("returns 404 when workflow does not exist", async () => {
    mockGetDualAuthContext.mockResolvedValue({
      userId: OWNER_USER_ID,
      organizationId: ORG_ID,
      authMethod: "session",
    });
    mockWorkflowsFindFirst.mockResolvedValue(undefined);

    const response = await GET(buildRequest(), buildContext());
    expect(response.status).toBe(404);
  });

  it("permits the workflow owner via session", async () => {
    mockGetDualAuthContext.mockResolvedValue({
      userId: OWNER_USER_ID,
      organizationId: ORG_ID,
      authMethod: "session",
    });
    mockWorkflowsFindFirst.mockResolvedValue({
      id: WORKFLOW_ID,
      userId: OWNER_USER_ID,
      organizationId: ORG_ID,
      isAnonymous: false,
      name: "wf",
      nodes: [],
      edges: [],
    });
    mockMemberLimit.mockResolvedValue([{ id: "member-1" }]);

    const response = await GET(buildRequest(), buildContext());
    expect(response.status).toBe(200);
  });

  it("returns 404 when an org workflow creator is no longer a member of that org", async () => {
    mockGetDualAuthContext.mockResolvedValue({
      userId: OWNER_USER_ID,
      organizationId: OTHER_ORG_ID,
      authMethod: "session",
    });
    mockWorkflowsFindFirst.mockResolvedValue({
      id: WORKFLOW_ID,
      userId: OWNER_USER_ID,
      organizationId: ORG_ID,
      isAnonymous: false,
      name: "wf",
      nodes: [],
      edges: [],
    });

    const response = await GET(buildRequest(), buildContext());
    expect(response.status).toBe(404);
  });

  it("permits a session user in the workflow's org even if not the owner", async () => {
    mockGetDualAuthContext.mockResolvedValue({
      userId: STRANGER_USER_ID,
      organizationId: ORG_ID,
      authMethod: "session",
    });
    mockMemberLimit.mockResolvedValue([{ id: "member-1" }]);
    mockWorkflowsFindFirst.mockResolvedValue({
      id: WORKFLOW_ID,
      userId: OWNER_USER_ID,
      organizationId: ORG_ID,
      isAnonymous: false,
      name: "wf",
      nodes: [],
      edges: [],
    });

    const response = await GET(buildRequest(), buildContext());
    expect(response.status).toBe(200);
  });

  it("permits an API-key caller whose org matches the workflow's org", async () => {
    mockGetDualAuthContext.mockResolvedValue({
      userId: OWNER_USER_ID,
      organizationId: ORG_ID,
      authMethod: "api-key",
    });
    mockMemberLimit.mockResolvedValue([{ id: "member-1" }]);
    mockWorkflowsFindFirst.mockResolvedValue({
      id: WORKFLOW_ID,
      userId: OWNER_USER_ID,
      organizationId: ORG_ID,
      isAnonymous: false,
      name: "wf",
      nodes: [],
      edges: [],
    });

    const response = await GET(buildRequest(), buildContext());
    expect(response.status).toBe(200);
  });

  it("returns 404 (access masked) when caller's org differs from workflow's org", async () => {
    mockGetDualAuthContext.mockResolvedValue({
      userId: STRANGER_USER_ID,
      organizationId: OTHER_ORG_ID,
      authMethod: "session",
    });
    mockWorkflowsFindFirst.mockResolvedValue({
      id: WORKFLOW_ID,
      userId: OWNER_USER_ID,
      organizationId: ORG_ID,
      isAnonymous: false,
      name: "wf",
      nodes: [],
      edges: [],
    });

    const response = await GET(buildRequest(), buildContext());
    expect(response.status).toBe(404);
  });

  it("returns 404 when workflow is anonymous and caller is not the owner", async () => {
    mockGetDualAuthContext.mockResolvedValue({
      userId: STRANGER_USER_ID,
      organizationId: ORG_ID,
      authMethod: "session",
    });
    mockWorkflowsFindFirst.mockResolvedValue({
      id: WORKFLOW_ID,
      userId: OWNER_USER_ID,
      organizationId: ORG_ID,
      isAnonymous: true,
      name: "wf",
      nodes: [],
      edges: [],
    });

    const response = await GET(buildRequest(), buildContext());
    expect(response.status).toBe(404);
  });
});
