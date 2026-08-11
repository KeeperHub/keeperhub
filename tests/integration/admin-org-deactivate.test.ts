import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_SECRET = "kha_test-admin-secret-12345";
const TEST_ORG_ID = "org-abc123";

type MockOrg = { id: string; deactivatedAt: Date | null } | undefined;
type MockWorkflows = { id: string }[];

let mockOrgForSelect: MockOrg;
let mockUpdateOrgReturning: MockOrg;
let mockWorkflowsDeactivated: MockWorkflows = [];
let mockShouldThrow = false;

vi.mock("@/lib/db", () => {
  const txMock = {
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(() => {
            if (mockShouldThrow) {
              throw new Error("DB error");
            }
            // First call = org update, second call = workflows update
            if (mockUpdateOrgReturning !== undefined) {
              const result = mockUpdateOrgReturning
                ? [mockUpdateOrgReturning]
                : [];
              mockUpdateOrgReturning = undefined;
              return Promise.resolve(result);
            }
            return Promise.resolve(mockWorkflowsDeactivated);
          }),
        })),
      })),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() =>
            Promise.resolve(mockOrgForSelect ? [mockOrgForSelect] : [])
          ),
        })),
      })),
    })),
  };

  return {
    db: {
      transaction: vi.fn((fn: (tx: typeof txMock) => Promise<unknown>) =>
        fn(txMock)
      ),
    },
  };
});

vi.mock("@/lib/db/schema", () => ({
  organization: { id: "id", deactivatedAt: "deactivated_at" },
  workflows: {
    id: "id",
    organizationId: "organization_id",
    deactivatedAt: "deactivated_at",
    deletedAt: "deleted_at",
    enabled: "enabled",
  },
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { DATABASE: "database" },
  logSystemError: vi.fn(),
}));

import { POST } from "@/app/api/admin/orgs/[orgId]/deactivate/route";

function makeRequest(token?: string): Request {
  const headers: Record<string, string> = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return new Request("http://localhost/api/admin/orgs/org-abc123/deactivate", {
    method: "POST",
    headers,
  });
}

function makeContext(orgId = TEST_ORG_ID) {
  return { params: Promise.resolve({ orgId }) };
}

describe("POST /api/admin/orgs/:orgId/deactivate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOrgForSelect = undefined;
    mockShouldThrow = false;
    mockWorkflowsDeactivated = [];
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
    it("deactivates the org and returns workflow count", async () => {
      mockUpdateOrgReturning = { id: TEST_ORG_ID, deactivatedAt: new Date() };
      mockWorkflowsDeactivated = [{ id: "wf-1" }, { id: "wf-2" }];

      const res = await POST(makeRequest(TEST_SECRET), makeContext());
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.orgId).toBe(TEST_ORG_ID);
      expect(data.workflowsDeactivated).toBe(2);
      expect(data.deactivatedAt).toBeDefined();
    });

    it("returns workflowsDeactivated = 0 when org has no active workflows", async () => {
      mockUpdateOrgReturning = { id: TEST_ORG_ID, deactivatedAt: new Date() };
      mockWorkflowsDeactivated = [];

      const res = await POST(makeRequest(TEST_SECRET), makeContext());
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.workflowsDeactivated).toBe(0);
    });
  });

  describe("error cases", () => {
    it("returns 404 when org does not exist", async () => {
      mockUpdateOrgReturning = undefined;
      mockOrgForSelect = undefined;

      const res = await POST(makeRequest(TEST_SECRET), makeContext());
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toBe("Organization not found");
    });

    it("returns 409 when org is already deactivated", async () => {
      mockUpdateOrgReturning = undefined;
      mockOrgForSelect = { id: TEST_ORG_ID, deactivatedAt: new Date() };

      const res = await POST(makeRequest(TEST_SECRET), makeContext());
      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.error).toBe("Organization is already deactivated");
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
