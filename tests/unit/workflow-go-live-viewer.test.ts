import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const {
  mockGetDualAuthContext,
  mockGetWorkflowAccess,
  mockWorkflowsFindFirst,
  mockTransaction,
  mockRecordAuditEvent,
} = vi.hoisted(() => ({
  mockGetDualAuthContext: vi.fn(),
  mockGetWorkflowAccess: vi.fn(),
  mockWorkflowsFindFirst: vi.fn(),
  mockTransaction: vi.fn(),
  mockRecordAuditEvent: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    query: { workflows: { findFirst: mockWorkflowsFindFirst } },
    transaction: mockTransaction,
  },
}));

vi.mock("@/lib/middleware/auth-helpers", () => ({
  getDualAuthContext: mockGetDualAuthContext,
  authFailureResponse: vi.fn(),
}));

vi.mock("@/lib/middleware/require-scope", () => ({
  requireScope: vi.fn().mockReturnValue(null),
}));

vi.mock("@/lib/workflow/access", () => ({
  getWorkflowAccess: mockGetWorkflowAccess,
}));

vi.mock("@/lib/security/audit-log", () => ({
  buildActor: vi.fn().mockReturnValue({}),
  buildAuditMetadata: vi.fn().mockReturnValue({}),
  recordAuditEvent: mockRecordAuditEvent,
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { DATABASE: "DATABASE" },
  logSystemError: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
}));

import { PUT } from "@/app/api/workflows/[workflowId]/go-live/route";
import { eoaWorkflowLockedMessage } from "@/lib/workflow/validation/eoa-workflow-lock";

const WORKFLOW = {
  id: "wf_1",
  userId: "user_1",
  organizationId: "org_1",
  name: "Workflow",
  visibility: "private",
  isListed: false,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

function callGoLive(): Promise<Response> {
  const request = new Request("http://localhost/api/workflows/wf_1/go-live", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Listed", mode: "public" }),
  });
  return PUT(request, { params: Promise.resolve({ workflowId: "wf_1" }) });
}

describe("PUT /api/workflows/[workflowId]/go-live viewer check", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDualAuthContext.mockResolvedValue({
      userId: "user_2",
      organizationId: "org_1",
      authMethod: "session",
      scope: undefined,
      apiKeyId: null,
    });
    mockWorkflowsFindFirst.mockResolvedValue(WORKFLOW);
    mockTransaction.mockImplementation(
      async (
        callback: (tx: Record<string, unknown>) => Promise<void>
      ): Promise<void> => {
        await callback({
          update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn() })) })),
          delete: vi.fn(() => ({ where: vi.fn() })),
          insert: vi.fn(() => ({ values: vi.fn() })),
        });
      }
    );
    mockRecordAuditEvent.mockResolvedValue(undefined);
  });

  it("returns 403 viewer_read_only and lists nothing for a same-org viewer", async () => {
    mockGetWorkflowAccess.mockResolvedValue({
      hasFullAccess: true,
      canEdit: false,
      isDeleted: false,
    });

    const response = await callGoLive();

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "Viewers have read-only access to this organization",
      code: "viewer_read_only",
    });
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockRecordAuditEvent).not.toHaveBeenCalled();
  });

  it("lists the workflow for a same-org editor", async () => {
    mockGetWorkflowAccess.mockResolvedValue({
      hasFullAccess: true,
      canEdit: true,
      isDeleted: false,
    });

    const response = await callGoLive();

    expect(response.status).toBe(200);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockRecordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: "workflow.listed" })
    );
  });
});

describe("PUT /api/workflows/[workflowId]/go-live with an EOA step", () => {
  const EOA_WORKFLOW = {
    ...WORKFLOW,
    nodes: [
      {
        id: "step-1",
        type: "action",
        data: {
          type: "action",
          label: "Send",
          config: {
            actionType: "web3/write-contract",
            network: "1",
            web3Connection: "eoa",
          },
        },
      },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockWorkflowsFindFirst.mockResolvedValue(EOA_WORKFLOW);
    mockGetWorkflowAccess.mockResolvedValue({
      hasFullAccess: true,
      canEdit: true,
      isDeleted: false,
    });
    mockTransaction.mockResolvedValue(undefined);
    mockRecordAuditEvent.mockResolvedValue(undefined);
  });

  it("refuses an API key", async () => {
    mockGetDualAuthContext.mockResolvedValue({
      userId: "user_1",
      organizationId: "org_1",
      authMethod: "api-key",
      apiKeyId: "key_1",
    });

    const response = await callGoLive();

    expect(response.status).toBe(422);
    const body = (await response.json()) as {
      invalidFields: { message: string; path: string }[];
    };
    expect(body.invalidFields).toEqual([
      expect.objectContaining({
        path: "isListed",
        message: eoaWorkflowLockedMessage(["step-1"], true),
      }),
    ]);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("lists it for an editor session", async () => {
    mockGetDualAuthContext.mockResolvedValue({
      userId: "user_1",
      organizationId: "org_1",
      authMethod: "session",
    });

    const response = await callGoLive();

    expect(response.status).toBe(200);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });
});
