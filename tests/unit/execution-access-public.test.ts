import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { mockGetDualAuthContext, mockFindFirst, mockAuthenticateApiKey } =
  vi.hoisted(() => ({
    mockGetDualAuthContext: vi.fn(),
    mockFindFirst: vi.fn(),
    mockAuthenticateApiKey: vi.fn(),
  }));

vi.mock("@/lib/middleware/auth-helpers", () => ({
  getDualAuthContext: mockGetDualAuthContext,
  // Mirrors the real guard. Not importOriginal'd because the real module
  // pulls in lib/auth (better-auth + its DB adapter), which this unit test
  // deliberately does not stand up.
  hasResolvedPrincipal: (context: {
    error?: string;
    userId?: string | null;
    organizationId?: string | null;
  }) =>
    "error" in context
      ? false
      : Boolean(context.userId || context.organizationId),
}));

vi.mock("@/lib/api-key-auth", () => ({
  authenticateApiKey: mockAuthenticateApiKey,
}));

vi.mock("@/lib/workflow/access", () => ({
  getWorkflowAccess: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      workflowExecutions: {
        findFirst: mockFindFirst,
      },
    },
  },
}));

import { getWorkflowAccess } from "@/lib/workflow/access";
import {
  redactExecutionStatusForPublicView,
  resolveExecutionViewAccess,
} from "@/lib/workflow/execution-access";

const mockGetWorkflowAccess = vi.mocked(getWorkflowAccess);

const EXECUTION_ID = "exec_test_1";
const WORKFLOW_ID = "wf_test_1";

function makeExecution(overrides?: {
  visibility?: "private" | "public" | "unlisted";
  shareExecutionStatus?: boolean;
  deletedAt?: Date | null;
}) {
  return {
    id: EXECUTION_ID,
    status: "success",
    workflowId: WORKFLOW_ID,
    totalSteps: "2",
    completedSteps: "2",
    currentNodeId: null,
    currentNodeName: null,
    lastSuccessfulNodeId: null,
    lastSuccessfulNodeName: null,
    executionTrace: ["step-a"],
    error: null,
    transactionHashes: [],
    workflow: {
      id: WORKFLOW_ID,
      name: "Test Workflow",
      userId: "user_1",
      organizationId: "org_1",
      isAnonymous: false,
      visibility: overrides?.visibility ?? "private",
      shareExecutionStatus: overrides?.shareExecutionStatus ?? false,
      deletedAt: overrides?.deletedAt ?? null,
    },
  };
}

function makeRequest(): Request {
  return new Request(`http://localhost/executions/${EXECUTION_ID}`);
}

const unauthenticatedContext = {
  userId: null,
  organizationId: null,
  authMethod: "session" as const,
  apiKeyId: null,
  isAnonymous: false,
};

const crossOrgContext = {
  userId: "user_2",
  organizationId: "org_2",
  authMethod: "session" as const,
  apiKeyId: null,
  isAnonymous: false,
};

describe("resolveExecutionViewAccess", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthenticateApiKey.mockResolvedValue({ authenticated: false });
    mockGetDualAuthContext.mockResolvedValue(unauthenticatedContext);
  });

  it("returns full for an anonymous-account owner of a private workflow", async () => {
    // A better-auth anonymous account is a real principal with its own org.
    // The canvas polls this route while its run is in flight, and the sibling
    // /logs endpoint authorizes the same caller, so it must not 404 here.
    const execution = makeExecution({ visibility: "private" });
    mockFindFirst.mockResolvedValue(execution);
    mockGetDualAuthContext.mockResolvedValue({
      userId: "anon_user",
      organizationId: "org_anon",
      authMethod: "session",
      apiKeyId: null,
      isAnonymous: true,
    });
    mockGetWorkflowAccess.mockResolvedValue({
      isCreatorWithCurrentAccess: true,
      isSameOrg: true,
      hasFullAccess: true,
      isDeleted: false,
    });

    const result = await resolveExecutionViewAccess(
      makeRequest(),
      EXECUTION_ID
    );

    expect(result).toEqual({ mode: "full", execution });
  });

  it("returns notFound for an anonymous session with no access", async () => {
    const execution = makeExecution({ visibility: "private" });
    mockFindFirst.mockResolvedValue(execution);
    mockGetDualAuthContext.mockResolvedValue({
      userId: "anon_user",
      organizationId: "org_anon",
      authMethod: "session",
      apiKeyId: null,
      isAnonymous: true,
    });
    mockGetWorkflowAccess.mockResolvedValue({
      isCreatorWithCurrentAccess: false,
      isSameOrg: false,
      hasFullAccess: false,
      isDeleted: false,
    });

    const result = await resolveExecutionViewAccess(
      makeRequest(),
      EXECUTION_ID
    );

    expect(result).toEqual({ mode: "notFound" });
  });

  it("returns invalidAuth for malformed API key header", async () => {
    mockFindFirst.mockResolvedValue(makeExecution());
    mockAuthenticateApiKey.mockResolvedValue({
      authenticated: false,
      error: "Invalid API key format. Expected key starting with kh_",
      statusCode: 401,
    });

    const result = await resolveExecutionViewAccess(
      new Request(`http://localhost/executions/${EXECUTION_ID}`, {
        headers: { Authorization: "Bearer kh_bad" },
      }),
      EXECUTION_ID
    );

    expect(result).toEqual({
      mode: "invalidAuth",
      error: "Invalid API key format. Expected key starting with kh_",
    });
  });

  it("returns invalidAuth for an OAuth Bearer that did not authenticate", async () => {
    // An expired MCP token degrades to a null principal exactly like no
    // credential at all; without a 401 the client cannot tell "refresh your
    // token" from "no such execution" and retries the dead token forever.
    mockFindFirst.mockResolvedValue(makeExecution());

    const result = await resolveExecutionViewAccess(
      new Request(`http://localhost/executions/${EXECUTION_ID}`, {
        headers: { Authorization: "Bearer expired-oauth-token" },
      }),
      EXECUTION_ID
    );

    expect(result).toEqual({
      mode: "invalidAuth",
      error: "Invalid or expired access token",
    });
    // Only the failing kh_ path pays for a second api-key lookup.
    expect(mockAuthenticateApiKey).not.toHaveBeenCalled();
  });

  it("reuses a caller-supplied auth context instead of resolving again", async () => {
    const execution = makeExecution({ visibility: "private" });
    mockFindFirst.mockResolvedValue(execution);
    mockGetWorkflowAccess.mockResolvedValue({
      isCreatorWithCurrentAccess: true,
      isSameOrg: true,
      hasFullAccess: true,
      isDeleted: false,
    });

    const result = await resolveExecutionViewAccess(
      makeRequest(),
      EXECUTION_ID,
      {
        userId: "user_1",
        organizationId: "org_1",
        authMethod: "session",
        apiKeyId: null,
        isAnonymous: false,
      }
    );

    expect(result).toEqual({ mode: "full", execution });
    expect(mockGetDualAuthContext).not.toHaveBeenCalled();
  });

  it("returns notFound when auth context returns an error", async () => {
    mockFindFirst.mockResolvedValue(makeExecution({ visibility: "private" }));
    mockGetDualAuthContext.mockResolvedValue({
      error: "Unauthorized",
      status: 401,
    });

    const result = await resolveExecutionViewAccess(
      makeRequest(),
      EXECUTION_ID
    );

    expect(result).toEqual({ mode: "notFound" });
  });

  it("returns accessDenied for authenticated member on deleted workflow", async () => {
    const execution = makeExecution({
      visibility: "private",
      deletedAt: new Date(),
    });
    mockFindFirst.mockResolvedValue(execution);
    mockGetDualAuthContext.mockResolvedValue({
      userId: "user_1",
      organizationId: "org_1",
      authMethod: "session",
      apiKeyId: null,
      isAnonymous: false,
    });
    mockGetWorkflowAccess.mockResolvedValue({
      isCreatorWithCurrentAccess: true,
      isSameOrg: true,
      hasFullAccess: true,
      isDeleted: true,
    });

    const result = await resolveExecutionViewAccess(
      makeRequest(),
      EXECUTION_ID
    );

    expect(result).toEqual({ mode: "accessDenied" });
  });

  it("returns notFound when execution is missing", async () => {
    mockFindFirst.mockResolvedValue(undefined);

    const result = await resolveExecutionViewAccess(
      makeRequest(),
      EXECUTION_ID
    );

    expect(result).toEqual({ mode: "notFound" });
  });

  it("returns full for org member with access", async () => {
    const execution = makeExecution({ visibility: "private" });
    mockFindFirst.mockResolvedValue(execution);
    mockGetDualAuthContext.mockResolvedValue({
      userId: "user_1",
      organizationId: "org_1",
      authMethod: "session",
      apiKeyId: null,
      isAnonymous: false,
    });
    mockGetWorkflowAccess.mockResolvedValue({
      isCreatorWithCurrentAccess: true,
      isSameOrg: true,
      hasFullAccess: true,
      isDeleted: false,
    });

    const result = await resolveExecutionViewAccess(
      makeRequest(),
      EXECUTION_ID
    );

    expect(result).toEqual({ mode: "full", execution });
  });

  it("returns full for owner viewing own public shared run", async () => {
    const execution = makeExecution({
      visibility: "public",
      shareExecutionStatus: true,
    });
    mockFindFirst.mockResolvedValue(execution);
    mockGetDualAuthContext.mockResolvedValue({
      userId: "user_1",
      organizationId: "org_1",
      authMethod: "session",
      apiKeyId: null,
      isAnonymous: false,
    });
    mockGetWorkflowAccess.mockResolvedValue({
      isCreatorWithCurrentAccess: true,
      isSameOrg: true,
      hasFullAccess: true,
      isDeleted: false,
    });

    const result = await resolveExecutionViewAccess(
      makeRequest(),
      EXECUTION_ID
    );

    expect(result).toEqual({ mode: "full", execution });
  });

  it("returns publicReadOnly for unauthenticated opted-in public workflow", async () => {
    const execution = makeExecution({
      visibility: "public",
      shareExecutionStatus: true,
    });
    mockFindFirst.mockResolvedValue(execution);
    mockGetDualAuthContext.mockResolvedValue(unauthenticatedContext);

    const result = await resolveExecutionViewAccess(
      makeRequest(),
      EXECUTION_ID
    );

    expect(result).toEqual({ mode: "publicReadOnly", execution });
  });

  it("returns publicReadOnly for unauthenticated opted-in unlisted workflow", async () => {
    const execution = makeExecution({
      visibility: "unlisted",
      shareExecutionStatus: true,
    });
    mockFindFirst.mockResolvedValue(execution);
    mockGetDualAuthContext.mockResolvedValue(unauthenticatedContext);

    const result = await resolveExecutionViewAccess(
      makeRequest(),
      EXECUTION_ID
    );

    expect(result).toEqual({ mode: "publicReadOnly", execution });
  });

  it("returns notFound for unauthenticated public workflow without share opt-in", async () => {
    const execution = makeExecution({
      visibility: "public",
      shareExecutionStatus: false,
    });
    mockFindFirst.mockResolvedValue(execution);
    mockGetDualAuthContext.mockResolvedValue(unauthenticatedContext);

    const result = await resolveExecutionViewAccess(
      makeRequest(),
      EXECUTION_ID
    );

    expect(result).toEqual({ mode: "notFound" });
  });

  it("returns notFound for authenticated cross-org public workflow without share opt-in", async () => {
    const execution = makeExecution({
      visibility: "public",
      shareExecutionStatus: false,
    });
    mockFindFirst.mockResolvedValue(execution);
    mockGetDualAuthContext.mockResolvedValue(crossOrgContext);
    mockGetWorkflowAccess.mockResolvedValue({
      isCreatorWithCurrentAccess: false,
      isSameOrg: false,
      hasFullAccess: false,
      isDeleted: false,
    });

    const result = await resolveExecutionViewAccess(
      makeRequest(),
      EXECUTION_ID
    );

    expect(result).toEqual({ mode: "notFound" });
  });

  it("returns notFound for unauthenticated private workflow", async () => {
    const execution = makeExecution({ visibility: "private" });
    mockFindFirst.mockResolvedValue(execution);
    mockGetDualAuthContext.mockResolvedValue(unauthenticatedContext);

    const result = await resolveExecutionViewAccess(
      makeRequest(),
      EXECUTION_ID
    );

    expect(result).toEqual({ mode: "notFound" });
  });

  it("returns notFound, not accessDenied, for a cross-org caller", async () => {
    // Anti-enumeration: a signed-in stranger must not be able to tell a real
    // execution id from a fabricated one. Both answer 404, matching the
    // collapse resolveAuthorizedExecution makes on the logs and wait routes.
    const execution = makeExecution({ visibility: "private" });
    mockFindFirst.mockResolvedValue(execution);
    mockGetDualAuthContext.mockResolvedValue(crossOrgContext);
    mockGetWorkflowAccess.mockResolvedValue({
      isCreatorWithCurrentAccess: false,
      isSameOrg: false,
      hasFullAccess: false,
      isDeleted: false,
    });

    const knownId = await resolveExecutionViewAccess(
      makeRequest(),
      EXECUTION_ID
    );

    mockFindFirst.mockResolvedValue(undefined);
    const fabricatedId = await resolveExecutionViewAccess(
      makeRequest(),
      "exec_does_not_exist"
    );

    expect(knownId).toEqual({ mode: "notFound" });
    expect(knownId).toEqual(fabricatedId);
  });

  it("returns publicReadOnly for API key org context without userId on shared workflow", async () => {
    const execution = makeExecution({
      visibility: "public",
      shareExecutionStatus: true,
    });
    mockFindFirst.mockResolvedValue(execution);
    mockGetDualAuthContext.mockResolvedValue({
      userId: null,
      organizationId: "org_other",
      authMethod: "api_key",
      apiKeyId: "key_1",
      isAnonymous: false,
    });
    mockGetWorkflowAccess.mockResolvedValue({
      isCreatorWithCurrentAccess: false,
      isSameOrg: false,
      hasFullAccess: false,
      isDeleted: false,
    });

    const result = await resolveExecutionViewAccess(
      makeRequest(),
      EXECUTION_ID
    );

    expect(result).toEqual({ mode: "publicReadOnly", execution });
  });

  it("returns notFound for deleted shared workflow when viewer is not a member", async () => {
    const execution = makeExecution({
      visibility: "public",
      shareExecutionStatus: true,
      deletedAt: new Date(),
    });
    mockFindFirst.mockResolvedValue(execution);
    mockGetDualAuthContext.mockResolvedValue(unauthenticatedContext);

    const result = await resolveExecutionViewAccess(
      makeRequest(),
      EXECUTION_ID
    );

    expect(result).toEqual({ mode: "notFound" });
  });
});

describe("redactExecutionStatusForPublicView", () => {
  it("strips node-identifying fields from public payloads", () => {
    const payload = {
      status: "error",
      nodeStatuses: [{ nodeId: "n1", status: "error" as const }],
      progress: {
        totalSteps: 1,
        completedSteps: 0,
        runningSteps: 0,
        currentNodeId: "n1",
        currentNodeName: "Step",
        percentage: 0,
      },
      errorContext: {
        failedNodeId: "n1",
        lastSuccessfulNodeId: null,
        lastSuccessfulNodeName: null,
        executionTrace: ["secret trace"],
        error: "internal error detail",
      },
      transactionHashes: [
        {
          nodeId: "n1",
          nodeName: "Transfer",
          hash: "0xabc",
          chainId: 1,
          network: "internal-rpc-alias",
          iterationIndex: 3,
          verified: true,
          receiptStatus: "success" as const,
        },
      ],
    };

    const redacted = redactExecutionStatusForPublicView(payload);

    expect(redacted.nodeStatuses).toEqual([{ nodeId: "", status: "error" }]);
    expect(redacted.progress.currentNodeId).toBeNull();
    expect(redacted.progress.currentNodeName).toBeNull();
    expect(redacted.errorContext).toEqual({
      failedNodeId: null,
      lastSuccessfulNodeId: null,
      lastSuccessfulNodeName: null,
    });
    // hash + chainId are the only fields the public share view renders
    // (the tx link and its explorer); everything else identifies an
    // internal workflow step or exposes internal execution detail.
    expect(redacted.transactionHashes[0]).toEqual({
      hash: "0xabc",
      chainId: 1,
      nodeId: "",
      nodeName: "",
    });
  });
});
