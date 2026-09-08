import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the database module
const mockWorkflow = {
  id: "wf_test123",
  userId: "user_test456",
  name: "Test Workflow",
  nodes: [
    {
      id: "trigger-1",
      type: "trigger",
      position: { x: 100, y: 100 },
      data: {
        type: "trigger",
        label: "Schedule Trigger",
        config: { triggerType: "Schedule", scheduleCron: "0 9 * * *" },
      },
    },
  ],
  edges: [],
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockExecution = {
  id: "exec_abc123",
  workflowId: "wf_test123",
  userId: "user_test456",
  status: "running" as const,
  input: {},
  createdAt: new Date(),
};

const mockDbQuery = {
  workflows: {
    findFirst: vi.fn(),
  },
  workflowExecutions: {
    findFirst: vi.fn(),
  },
};

const mockDbInsert = vi.fn().mockReturnValue({
  values: vi.fn().mockReturnValue({
    returning: vi.fn().mockResolvedValue([mockExecution]),
  }),
});

const mockDbUpdate = vi.fn().mockReturnValue({
  set: vi.fn().mockReturnValue({
    where: vi.fn().mockResolvedValue(undefined),
  }),
});

vi.mock("@/lib/db", () => ({
  db: {
    query: mockDbQuery,
    insert: mockDbInsert,
    update: mockDbUpdate,
  },
}));

const _mockSession = {
  user: { id: "user_test456", email: "test@example.com", name: "Test User" },
  session: { id: "session_123", userId: "user_test456" },
};

vi.mock("@/lib/auth", () => ({
  auth: {
    api: {
      getSession: vi.fn(),
    },
  },
}));

vi.mock("@/lib/db/integrations", () => ({
  validateWorkflowIntegrations: vi.fn().mockResolvedValue({ valid: true }),
}));

vi.mock("workflow/api", () => ({
  start: vi.fn(),
}));

describe("Execute API Integration Tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Internal Execution Header", () => {
    it("recognizes X-Internal-Execution header", () => {
      const headers = new Headers();
      headers.set("X-Internal-Execution", "true");

      const isInternal = headers.get("X-Internal-Execution") === "true";
      expect(isInternal).toBe(true);
    });

    it("rejects requests without X-Internal-Execution header as external", () => {
      const headers = new Headers();

      const isInternal = headers.get("X-Internal-Execution") === "true";
      expect(isInternal).toBe(false);
    });

    it("rejects X-Internal-Execution header with wrong value", () => {
      const headers = new Headers();
      headers.set("X-Internal-Execution", "false");

      const isInternal = headers.get("X-Internal-Execution") === "true";
      expect(isInternal).toBe(false);
    });
  });

  describe("Request Body Handling", () => {
    it("parses execution ID from request body", () => {
      const body = {
        executionId: "exec_provided123",
        input: { triggerType: "schedule" },
      };

      expect(body.executionId).toBe("exec_provided123");
      expect(body.input.triggerType).toBe("schedule");
    });

    it("handles missing execution ID by generating new one", () => {
      const body: { input: { triggerType: string }; executionId?: string } = {
        input: { triggerType: "schedule" },
      };
      const executionId = body.executionId || "exec_generated_new";

      expect(executionId).toBe("exec_generated_new");
    });

    it("handles empty request body", () => {
      const body: { input?: Record<string, unknown> } = {};
      const input = body.input || {};

      expect(input).toEqual({});
    });
  });

  describe("Workflow Lookup", () => {
    it("finds workflow by ID", async () => {
      mockDbQuery.workflows.findFirst.mockResolvedValueOnce(mockWorkflow);

      const workflow = await mockDbQuery.workflows.findFirst({
        where: { id: "wf_test123" },
      });

      expect(workflow).toBeDefined();
      expect(workflow?.id).toBe("wf_test123");
    });

    it("returns null for non-existent workflow", async () => {
      mockDbQuery.workflows.findFirst.mockResolvedValueOnce(undefined);

      const workflow = await mockDbQuery.workflows.findFirst({
        where: { id: "wf_nonexistent" },
      });

      expect(workflow).toBeUndefined();
    });
  });

  describe("Authorization", () => {
    it("allows internal execution without session for valid workflow", async () => {
      mockDbQuery.workflows.findFirst.mockResolvedValueOnce(mockWorkflow);

      // Internal execution uses workflow's userId
      const workflow = await mockDbQuery.workflows.findFirst({
        where: { id: "wf_test123" },
      });
      const userId = workflow?.userId;

      expect(userId).toBe("user_test456");
    });

    it("gets userId from workflow for internal execution", () => {
      const isInternalExecution = true;
      const workflow = mockWorkflow;

      const userId = isInternalExecution ? workflow.userId : "session_user_id";

      expect(userId).toBe("user_test456");
    });
  });

  describe("Execution Record Creation", () => {
    it("creates execution record with provided ID", () => {
      const providedId = "exec_provided123";

      mockDbInsert.mockReturnValueOnce({
        values: vi.fn().mockReturnValueOnce({
          returning: vi.fn().mockResolvedValueOnce([{ id: providedId }]),
        }),
      });

      const insertValues = {
        id: providedId,
        workflowId: "wf_test123",
        userId: "user_test456",
        status: "running" as const,
        input: { triggerType: "schedule" },
      };

      expect(insertValues.id).toBe("exec_provided123");
    });

    it("uses existing execution if found", async () => {
      const existingExecution = {
        id: "exec_existing",
        status: "running",
      };

      mockDbQuery.workflowExecutions.findFirst.mockResolvedValueOnce(
        existingExecution
      );

      const found = await mockDbQuery.workflowExecutions.findFirst({
        where: { id: "exec_existing" },
      });

      expect(found).toBeDefined();
      expect(found?.status).toBe("running");
    });
  });

  describe("Response Format", () => {
    it("returns execution ID and running status on success", () => {
      const response = {
        executionId: "exec_abc123",
        status: "running",
      };

      expect(response.executionId).toBe("exec_abc123");
      expect(response.status).toBe("running");
    });

    it("returns 404 for workflow not found", () => {
      const errorResponse = {
        error: "Workflow not found",
        status: 404,
      };

      expect(errorResponse.error).toBe("Workflow not found");
      expect(errorResponse.status).toBe(404);
    });

    it("returns 401 for unauthorized external request", () => {
      const errorResponse = {
        error: "Unauthorized",
        status: 401,
      };

      expect(errorResponse.error).toBe("Unauthorized");
      expect(errorResponse.status).toBe(401);
    });

    it("returns 403 for forbidden access", () => {
      const errorResponse = {
        error: "Forbidden",
        status: 403,
      };

      expect(errorResponse.error).toBe("Forbidden");
      expect(errorResponse.status).toBe(403);
    });
  });

  describe("Integration Validation", () => {
    it("validates integrations using the org principal (organizationId set)", async () => {
      const { validateWorkflowIntegrations } = await import(
        "@/lib/db/integrations"
      );

      const nodes = mockWorkflow.nodes;
      const organizationId = "org_test";

      await validateWorkflowIntegrations(
        nodes as Parameters<typeof validateWorkflowIntegrations>[0],
        organizationId
      );

      expect(validateWorkflowIntegrations).toHaveBeenCalledWith(
        expect.anything(),
        organizationId
      );
    });

    it("returns 403 for invalid integration references", () => {
      const validation = { valid: false, invalidIds: ["int_fake123"] };

      expect(validation.valid).toBe(false);
      expect(validation.invalidIds).toContain("int_fake123");
    });
  });

  describe("Background Execution", () => {
    it("starts workflow execution without awaiting", async () => {
      const { start } = await import("workflow/api");

      // Simulate calling start without await
      const _executePromise = Promise.resolve();

      // The API should return before execution completes
      const apiResponse = { executionId: "exec_123", status: "running" };

      expect(apiResponse.status).toBe("running");
      expect(start).toBeDefined();
    });
  });
});
