import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_SECRET = "kha_test-admin-secret-12345";
const TEST_WORKFLOW_ID = "wf-abc123";

type MockWorkflow =
  | { id: string; deactivatedAt: Date | null; deletedAt: Date | null }
  | undefined;

let mockWorkflowForSelect: MockWorkflow;
let mockDeactivatedWorkflow: { id: string; deactivatedAt: Date } | undefined;
let mockShouldThrow = false;

vi.mock("@/lib/db", () => {
  const txMock = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() =>
            Promise.resolve(
              mockWorkflowForSelect ? [mockWorkflowForSelect] : []
            )
          ),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(() =>
            Promise.resolve(
              mockDeactivatedWorkflow ? [mockDeactivatedWorkflow] : []
            )
          ),
        })),
      })),
    })),
  };

  return {
    db: {
      transaction: vi.fn((fn: (tx: typeof txMock) => Promise<unknown>) => {
        if (mockShouldThrow) {
          throw new Error("DB error");
        }
        return fn(txMock);
      }),
    },
  };
});

vi.mock("@/lib/db/schema", () => ({
  workflows: {
    id: "id",
    deactivatedAt: "deactivated_at",
    deletedAt: "deleted_at",
    enabled: "enabled",
  },
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { DATABASE: "database" },
  logSystemError: vi.fn(),
}));

import { POST } from "@/app/api/admin/workflows/[workflowId]/deactivate/route";

function makeRequest(token?: string): Request {
  const headers: Record<string, string> = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return new Request(
    "http://localhost/api/admin/workflows/wf-abc123/deactivate",
    {
      method: "POST",
      headers,
    }
  );
}

function makeContext(workflowId = TEST_WORKFLOW_ID) {
  return { params: Promise.resolve({ workflowId }) };
}

describe("POST /api/admin/workflows/:workflowId/deactivate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWorkflowForSelect = undefined;
    mockDeactivatedWorkflow = undefined;
    mockShouldThrow = false;
    vi.stubEnv("KH_ADMIN_SECRET", TEST_SECRET);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("authentication", () => {
    it("returns 401 when KH_ADMIN_SECRET is not configured", async () => {
      vi.stubEnv("KH_ADMIN_SECRET", "");
      const res = await POST(makeRequest(TEST_SECRET), makeContext());
      expect(res.status).toBe(401);
    });

    it("returns 401 when Authorization header is missing", async () => {
      const res = await POST(makeRequest(), makeContext());
      expect(res.status).toBe(401);
    });

    it("returns 401 when secret is wrong", async () => {
      const res = await POST(makeRequest("wrong-secret"), makeContext());
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error).toBe("Invalid KH admin secret");
    });
  });

  describe("happy path", () => {
    it("deactivates the workflow and returns workflowId and deactivatedAt", async () => {
      const now = new Date();
      mockWorkflowForSelect = {
        id: TEST_WORKFLOW_ID,
        deactivatedAt: null,
        deletedAt: null,
      };
      mockDeactivatedWorkflow = { id: TEST_WORKFLOW_ID, deactivatedAt: now };

      const res = await POST(makeRequest(TEST_SECRET), makeContext());
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.workflowId).toBe(TEST_WORKFLOW_ID);
      expect(data.deactivatedAt).toBeDefined();
    });
  });

  describe("error cases", () => {
    it("returns 404 when workflow does not exist", async () => {
      mockWorkflowForSelect = undefined;

      const res = await POST(makeRequest(TEST_SECRET), makeContext());
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toBe("Workflow not found");
    });

    it("returns 404 when workflow is soft-deleted", async () => {
      mockWorkflowForSelect = {
        id: TEST_WORKFLOW_ID,
        deactivatedAt: null,
        deletedAt: new Date(),
      };

      const res = await POST(makeRequest(TEST_SECRET), makeContext());
      expect(res.status).toBe(404);
    });

    it("returns 409 when workflow is already deactivated", async () => {
      mockWorkflowForSelect = {
        id: TEST_WORKFLOW_ID,
        deactivatedAt: new Date(),
        deletedAt: null,
      };

      const res = await POST(makeRequest(TEST_SECRET), makeContext());
      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.error).toBe("Workflow is already deactivated");
    });

    it("returns 500 on database error", async () => {
      mockShouldThrow = true;
      const res = await POST(makeRequest(TEST_SECRET), makeContext());
      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toBe("Internal server error");
    });
  });
});
