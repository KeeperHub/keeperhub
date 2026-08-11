import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// KEEP-545: route imports lib/errors/finalize-error which pulls in server-only
// via the metrics collector. Stubbing server-only as an empty module lets the
// test load the route without a Next runtime.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/errors/classify", () => ({
  classifyExecutionError: () => ({
    errorCategory: "workflow_engine",
    errorType: "system",
  }),
}));
vi.mock("@/lib/errors/finalize-error", () => ({
  recordExecutionErrorFinalized: vi.fn().mockResolvedValue(undefined),
}));

const VALID_API_KEY = "wfb_test-key-abc123";
const VALID_KEY_HASH = createHash("sha256").update(VALID_API_KEY).digest("hex");
const OWNER_USER_ID = "user-owner-123";
const OTHER_USER_ID = "user-other-456";
const WORKFLOW_ID = "wf-abc-123";

const webhookWorkflow = {
  id: WORKFLOW_ID,
  userId: OWNER_USER_ID,
  organizationId: "org-123",
  enabled: true,
  nodes: [
    {
      id: "trigger-1",
      type: "trigger",
      position: { x: 0, y: 0 },
      data: {
        label: "Webhook Trigger",
        type: "trigger",
        config: { triggerType: "Webhook" },
        status: "idle",
      },
    },
  ],
  edges: [],
};

const disabledWebhookWorkflow = {
  ...webhookWorkflow,
  enabled: false,
};

const manualWorkflow = {
  ...webhookWorkflow,
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
  ],
};

const {
  mockWorkflowsFindFirst,
  mockApiKeysFindFirst,
  mockOrgGateLimit,
  mockMemberLimit,
  mockInsertReturning,
  mockValidateIntegrations,
  mockEnforceExecutionLimit,
  mockCheckConcurrency,
  mockChargePaygIfBillable,
} = vi.hoisted(() => ({
  mockWorkflowsFindFirst: vi.fn(),
  mockApiKeysFindFirst: vi.fn(),
  mockOrgGateLimit: vi.fn().mockResolvedValue([{ orgDeactivatedAt: null }]),
  mockMemberLimit: vi.fn(),
  mockInsertReturning: vi.fn(),
  mockValidateIntegrations: vi.fn(),
  mockEnforceExecutionLimit: vi.fn(),
  mockCheckConcurrency: vi.fn(),
  mockChargePaygIfBillable: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        leftJoin: vi.fn(() => ({
          where: vi.fn(() => ({ limit: mockOrgGateLimit })),
        })),
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
      apiKeys: { findFirst: mockApiKeysFindFirst },
    },
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: mockInsertReturning,
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          catch: vi.fn(),
        })),
      })),
    })),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  apiKeys: { keyHash: "key_hash", id: "id", lastUsedAt: "last_used_at" },
  member: { id: "id", organizationId: "organizationId", userId: "userId" },
  workflows: { id: "id", organizationId: "organization_id" },
  organization: { id: "id", deactivatedAt: "deactivated_at" },
  workflowExecutions: { id: "id" },
  users: { id: "id", deactivatedAt: "deactivated_at" },
}));

vi.mock("@/lib/db/integrations", () => ({
  validateWorkflowIntegrations: mockValidateIntegrations,
}));

vi.mock("@/lib/billing/execution-guard", () => ({
  EXECUTION_LIMIT_ERROR: "Execution limit reached",
  enforceExecutionLimit: mockEnforceExecutionLimit,
}));

vi.mock("@/lib/billing/payg/charge", () => ({
  chargePaygIfBillable: mockChargePaygIfBillable,
}));

vi.mock("@/lib/features/route-guard", () => ({
  enforceWorkflowFeatures: vi.fn().mockResolvedValue({ blocked: false }),
  FEATURE_UPGRADE_REQUIRED_ERROR:
    "This workflow uses features that require a paid plan.",
}));

vi.mock("@/app/api/execute/_lib/concurrency-limit", () => ({
  checkConcurrencyLimit: mockCheckConcurrency,
}));

vi.mock("@/lib/metrics", () => ({
  createTimer: () => () => 0,
  getMetricsCollector: () => ({ incrementCounter: vi.fn() }),
}));

vi.mock("@/lib/metrics/types", () => ({
  LabelKeys: { TRIGGER_TYPE: "trigger_type", WORKFLOW_ID: "workflow_id" },
  MetricNames: { WORKFLOW_EXECUTIONS_TOTAL: "workflow_executions_total" },
}));

vi.mock("@/lib/metrics/instrumentation/api", () => ({
  recordWebhookMetrics: vi.fn(),
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { WORKFLOW_ENGINE: "WORKFLOW_ENGINE" },
  logSystemError: vi.fn(),
}));

vi.mock("workflow/api", () => ({
  start: vi.fn().mockResolvedValue({ runId: "run-123" }),
}));

vi.mock("@/lib/workflow/executor/executor.workflow", () => ({
  executeWorkflow: vi.fn(),
}));

import { OPTIONS, POST } from "@/app/api/workflows/[workflowId]/webhook/route";

function createWebhookRequest(
  apiKey?: string,
  body?: Record<string, unknown>
): Request {
  const url = `http://localhost:3000/api/workflows/${WORKFLOW_ID}/webhook`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return new Request(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body ?? {}),
  });
}

function createContext(workflowId: string): {
  params: Promise<{ workflowId: string }>;
} {
  return { params: Promise.resolve({ workflowId }) };
}

function setupHappyPath(): void {
  mockOrgGateLimit.mockResolvedValue([
    {
      workflow: webhookWorkflow,
      orgDeactivatedAt: null,
      organizationName: null,
    },
  ]);
  mockApiKeysFindFirst.mockResolvedValue({
    id: "key-1",
    userId: OWNER_USER_ID,
    keyHash: VALID_KEY_HASH,
  });
  mockMemberLimit.mockResolvedValue([{ id: "member-1" }]);
  mockValidateIntegrations.mockResolvedValue({ valid: true });
  mockEnforceExecutionLimit.mockResolvedValue({ blocked: false });
  mockCheckConcurrency.mockResolvedValue({ allowed: true });
  mockInsertReturning.mockResolvedValue([
    { id: "exec-001", status: "running" },
  ]);
}

describe("POST /api/workflows/:workflowId/webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // loadWorkflowForExecution now returns the workflow + org data in a single
    // left-join query (db.select().from(workflows).leftJoin(organization)).
    // The mock for that chain is mockOrgGateLimit; it must include the workflow
    // field so the helper recognises a found row.
    mockOrgGateLimit.mockResolvedValue([
      {
        workflow: webhookWorkflow,
        orgDeactivatedAt: null,
        organizationName: null,
      },
    ]);
    mockMemberLimit.mockResolvedValue([{ id: "member-1" }]);
    // Default: org is not PAYG-billable, so the charge is a no-op pass-through.
    mockChargePaygIfBillable.mockResolvedValue({ applicable: false });
  });

  describe("workflow lookup", () => {
    it("should return 404 when workflow not found", async () => {
      mockOrgGateLimit.mockResolvedValue([]);

      const response = await POST(
        createWebhookRequest(VALID_API_KEY),
        createContext(WORKFLOW_ID)
      );
      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error).toBe("Workflow not found");
    });
  });

  describe("disabled workflow", () => {
    it("should return 410 Gone when workflow.enabled is false", async () => {
      mockOrgGateLimit.mockResolvedValue([
        {
          workflow: disabledWebhookWorkflow,
          orgDeactivatedAt: null,
          organizationName: null,
        },
      ]);

      const response = await POST(
        createWebhookRequest(VALID_API_KEY),
        createContext(WORKFLOW_ID)
      );
      expect(response.status).toBe(410);
      const data = await response.json();
      expect(data.error).toBe("Workflow is disabled");
    });

    it("should not validate API key for a disabled workflow", async () => {
      mockOrgGateLimit.mockResolvedValue([
        {
          workflow: disabledWebhookWorkflow,
          orgDeactivatedAt: null,
          organizationName: null,
        },
      ]);

      await POST(
        createWebhookRequest(VALID_API_KEY),
        createContext(WORKFLOW_ID)
      );

      expect(mockApiKeysFindFirst).not.toHaveBeenCalled();
    });
  });

  describe("deactivated owner", () => {
    it("should return 404 when the workflow owner is deactivated", async () => {
      // Return a deactivated org so the executability gate rejects before auth.
      mockOrgGateLimit.mockResolvedValue([
        {
          workflow: webhookWorkflow,
          orgDeactivatedAt: new Date(),
          organizationName: null,
        },
      ]);

      const response = await POST(
        createWebhookRequest(VALID_API_KEY),
        createContext(WORKFLOW_ID)
      );

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error).toBe("Workflow not found");
      expect(mockApiKeysFindFirst).not.toHaveBeenCalled();
    });
  });

  describe("API key validation", () => {
    it("should return 401 when no authorization header", async () => {
      mockWorkflowsFindFirst.mockResolvedValue(webhookWorkflow);

      const response = await POST(
        createWebhookRequest(),
        createContext(WORKFLOW_ID)
      );
      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toBe("Missing Authorization header");
    });

    it("should return 401 with wrong_key_type hint when a kh_ org key is used", async () => {
      mockWorkflowsFindFirst.mockResolvedValue(webhookWorkflow);

      const response = await POST(
        createWebhookRequest("kh_wrong_prefix"),
        createContext(WORKFLOW_ID)
      );
      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toContain("wfb_");
      expect(data.error).toContain("kh_");
      expect(data.code).toBe("wrong_key_type");
      expect(data.expected).toBe("wfb_*");
      expect(data.received).toBe("kh_*");
      expect(typeof data.hint).toBe("string");
    });

    it("should return 401 with expected prefix when key has unknown prefix", async () => {
      mockWorkflowsFindFirst.mockResolvedValue(webhookWorkflow);

      const response = await POST(
        createWebhookRequest("totally_unknown_key"),
        createContext(WORKFLOW_ID)
      );
      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toContain("wfb_");
      expect(data.code).toBe("invalid_key_format");
      expect(data.expected).toBe("wfb_*");
    });

    it("should return 401 when key not found in database", async () => {
      mockWorkflowsFindFirst.mockResolvedValue(webhookWorkflow);
      mockApiKeysFindFirst.mockResolvedValue(null);

      const response = await POST(
        createWebhookRequest(VALID_API_KEY),
        createContext(WORKFLOW_ID)
      );
      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toBe("Invalid API key");
    });

    it("should return 403 when key belongs to a non-member user", async () => {
      mockWorkflowsFindFirst.mockResolvedValue(webhookWorkflow);
      mockApiKeysFindFirst.mockResolvedValue({
        id: "key-other",
        userId: OTHER_USER_ID,
        keyHash: VALID_KEY_HASH,
      });
      // OTHER_USER_ID is not a member of the workflow's org
      mockMemberLimit.mockResolvedValue([]);

      const response = await POST(
        createWebhookRequest(VALID_API_KEY),
        createContext(WORKFLOW_ID)
      );
      expect(response.status).toBe(403);
      const data = await response.json();
      expect(data.error).toBe(
        "You do not have permission to run this workflow"
      );
    });

    it("should return 403 when the key holder is no longer an org member", async () => {
      mockWorkflowsFindFirst.mockResolvedValue(webhookWorkflow);
      mockApiKeysFindFirst.mockResolvedValue({
        id: "key-1",
        userId: OWNER_USER_ID,
        keyHash: VALID_KEY_HASH,
      });
      mockMemberLimit.mockResolvedValue([]);

      const response = await POST(
        createWebhookRequest(VALID_API_KEY),
        createContext(WORKFLOW_ID)
      );
      expect(response.status).toBe(403);
      const data = await response.json();
      expect(data.error).toBe(
        "You do not have permission to run this workflow"
      );
    });
  });

  describe("webhook trigger validation", () => {
    it("should return 400 when workflow is not webhook-triggered", async () => {
      mockOrgGateLimit.mockResolvedValue([
        {
          workflow: manualWorkflow,
          orgDeactivatedAt: null,
          organizationName: null,
        },
      ]);
      mockApiKeysFindFirst.mockResolvedValue({
        id: "key-1",
        userId: OWNER_USER_ID,
        keyHash: VALID_KEY_HASH,
      });

      const response = await POST(
        createWebhookRequest(VALID_API_KEY),
        createContext(WORKFLOW_ID)
      );
      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe(
        "This workflow is not configured for webhook triggers"
      );
    });
  });

  describe("integration validation", () => {
    it("should return 403 when workflow has invalid integrations", async () => {
      mockWorkflowsFindFirst.mockResolvedValue(webhookWorkflow);
      mockApiKeysFindFirst.mockResolvedValue({
        id: "key-1",
        userId: OWNER_USER_ID,
        keyHash: VALID_KEY_HASH,
      });
      mockValidateIntegrations.mockResolvedValue({
        valid: false,
        invalidIds: ["int-999"],
      });

      const response = await POST(
        createWebhookRequest(VALID_API_KEY),
        createContext(WORKFLOW_ID)
      );
      expect(response.status).toBe(403);
      const data = await response.json();
      expect(data.error).toBe(
        "Workflow contains invalid integration references"
      );
    });
  });

  describe("rate limiting", () => {
    it("should return 429 when execution limit reached", async () => {
      mockWorkflowsFindFirst.mockResolvedValue(webhookWorkflow);
      mockApiKeysFindFirst.mockResolvedValue({
        id: "key-1",
        userId: OWNER_USER_ID,
        keyHash: VALID_KEY_HASH,
      });
      mockValidateIntegrations.mockResolvedValue({ valid: true });
      mockEnforceExecutionLimit.mockResolvedValue({
        blocked: true,
        response: new Response(
          JSON.stringify({ error: "Execution limit reached", limit: 100 }),
          { status: 429 }
        ),
      });

      const response = await POST(
        createWebhookRequest(VALID_API_KEY),
        createContext(WORKFLOW_ID)
      );
      expect(response.status).toBe(429);
      // The execution-limit 429 must carry limiter headers like the
      // concurrency 429, with the limit surfaced from the guard body.
      expect(response.headers.get("Retry-After")).toBe("30");
      expect(response.headers.get("X-RateLimit-Limit")).toBe("100");
      expect(response.headers.get("X-RateLimit-Remaining")).toBe("0");
    });

    it("should return 429 when concurrency limit reached", async () => {
      mockWorkflowsFindFirst.mockResolvedValue(webhookWorkflow);
      mockApiKeysFindFirst.mockResolvedValue({
        id: "key-1",
        userId: OWNER_USER_ID,
        keyHash: VALID_KEY_HASH,
      });
      mockValidateIntegrations.mockResolvedValue({ valid: true });
      mockEnforceExecutionLimit.mockResolvedValue({ blocked: false });
      mockCheckConcurrency.mockResolvedValue({
        allowed: false,
        running: 10,
        limit: 10,
      });

      const response = await POST(
        createWebhookRequest(VALID_API_KEY),
        createContext(WORKFLOW_ID)
      );
      expect(response.status).toBe(429);
      const data = await response.json();
      expect(data.error).toBe("Too many concurrent workflow executions");
      expect(data.running).toBe(10);
      expect(data.limit).toBe(10);
    });
  });

  describe("successful execution", () => {
    it("should return 200 with execution ID", async () => {
      setupHappyPath();

      const response = await POST(
        createWebhookRequest(VALID_API_KEY, { event: "test" }),
        createContext(WORKFLOW_ID)
      );
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.executionId).toBe("exec-001");
      expect(data.status).toBe("running");
    });

    it("should include CORS headers", async () => {
      setupHappyPath();

      const response = await POST(
        createWebhookRequest(VALID_API_KEY),
        createContext(WORKFLOW_ID)
      );
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(response.headers.get("Access-Control-Allow-Methods")).toContain(
        "POST"
      );
    });
  });

  describe("pay-as-you-go charge", () => {
    it("returns 402 and marks the run errored when the PAYG charge is blocked", async () => {
      setupHappyPath();
      const message =
        "Daily pay-as-you-go spend limit reached. Raise your daily limit or wait until tomorrow.";
      mockChargePaygIfBillable.mockResolvedValue({
        applicable: true,
        ok: false,
        reason: "daily_cap",
        message,
      });

      const response = await POST(
        createWebhookRequest(VALID_API_KEY, { event: "test" }),
        createContext(WORKFLOW_ID)
      );

      expect(response.status).toBe(402);
      const data = await response.json();
      expect(data.error).toBe(message);
      expect(data.status).toBe("error");
    });
  });

  describe("OPTIONS preflight", () => {
    it("should return CORS headers", () => {
      const response = OPTIONS();
      expect(response.status).toBe(200);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(response.headers.get("Access-Control-Allow-Headers")).toContain(
        "Authorization"
      );
    });
  });
});
