/**
 * Integration tests for POST /api/workflows/[workflowId]/trigger-preview.
 *
 * The route authenticates the caller, enforces workflow access and previews
 * the saved database definition rather than accepting trigger config from the
 * request body. The preview itself is covered by
 * tests/unit/event-trigger-preview.test.ts; what is asserted here is the
 * access boundary, the body validation and that a preview never runs for a
 * caller who is not entitled to it.
 */

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockGetDualAuthContext = vi.fn();
vi.mock("@/lib/middleware/auth-helpers", () => ({
  getDualAuthContext: (...args: unknown[]) => mockGetDualAuthContext(...args),
}));

const mockGetWorkflowAccess = vi.fn();
vi.mock("@/lib/workflow/access", () => ({
  getWorkflowAccess: (...args: unknown[]) => mockGetWorkflowAccess(...args),
}));

const mockRunEventTriggerPreview = vi.fn();
vi.mock("@/lib/workflow/trigger-preview/event-trigger-preview", () => ({
  MAX_LOOKBACK_BLOCKS: 50_000,
  runEventTriggerPreview: (...args: unknown[]) =>
    mockRunEventTriggerPreview(...args),
}));

const mockCheckRateLimit = vi.fn();
vi.mock("@/app/api/execute/_lib/rate-limit", () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}));

let mockWorkflowRows: unknown[] = [];

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve(mockWorkflowRows)),
        })),
      })),
    })),
  },
}));

import { POST } from "@/app/api/workflows/[workflowId]/trigger-preview/route";

const OWNER_USER_ID = "user-owner";
const OWNER_ORG_ID = "org-owner";
const WORKFLOW_ID = "workflow-1";

const savedNodes = [
  {
    id: "trigger-1",
    type: "trigger",
    data: {
      label: "Trigger",
      type: "trigger",
      config: {
        triggerType: "Event",
        network: "1",
        contractAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
        contractABI: "[]",
        eventName: "Transfer",
      },
    },
  },
];

const workflowRow = {
  id: WORKFLOW_ID,
  userId: OWNER_USER_ID,
  organizationId: OWNER_ORG_ID,
  deletedAt: null,
  nodes: savedNodes,
  edges: [],
};

const ownerAuthContext = {
  userId: OWNER_USER_ID,
  organizationId: OWNER_ORG_ID,
  authMethod: "session" as const,
  apiKeyId: null,
  isAnonymous: false,
};

const fullAccess = {
  isCreatorWithCurrentAccess: true,
  isSameOrg: true,
  hasFullAccess: true,
  isDeleted: false,
};

const previewResult = {
  verdict: "ok",
  summary: "2 Transfer events matched.",
  findings: [],
  scan: {
    fromBlock: 5000,
    toBlock: 10_000,
    blocksScanned: 5001,
    spanSeconds: 60_000,
  },
  matchCount: 2,
  filteredOutCount: 0,
  estimatedFiresPerDay: 2.9,
  samples: [],
};

function makeRequest(workflowId: string, body?: unknown): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/workflows/${workflowId}/trigger-preview`,
    {
      method: "POST",
      ...(body === undefined
        ? {}
        : {
            body: JSON.stringify(body),
            headers: { "content-type": "application/json" },
          }),
    }
  );
}

function makeParams(workflowId: string) {
  return { params: Promise.resolve({ workflowId }) };
}

describe("/api/workflows/[workflowId]/trigger-preview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWorkflowRows = [workflowRow];
    mockGetDualAuthContext.mockResolvedValue(ownerAuthContext);
    mockGetWorkflowAccess.mockResolvedValue(fullAccess);
    mockCheckRateLimit.mockReturnValue({
      allowed: true,
      limit: 60,
      remaining: 59,
      reset: 1_800_000_000,
    });
    mockRunEventTriggerPreview.mockResolvedValue(previewResult);
  });

  it("returns the preview for an entitled caller", async () => {
    const response = await POST(
      makeRequest(WORKFLOW_ID),
      makeParams(WORKFLOW_ID)
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, result: previewResult });
    expect(mockRunEventTriggerPreview).toHaveBeenCalledWith({
      nodes: savedNodes,
      userId: OWNER_USER_ID,
      lookbackBlocks: undefined,
      // The route always bounds the scan in time; the value is a clock
      // reading, so only its presence is asserted here.
      deadlineAt: expect.any(Number),
    });
  });

  it("returns 401 when authentication fails", async () => {
    mockGetDualAuthContext.mockResolvedValue({
      error: "UNAUTHORIZED",
      status: 401,
    });

    const response = await POST(
      makeRequest(WORKFLOW_ID),
      makeParams(WORKFLOW_ID)
    );

    expect(response.status).toBe(401);
    expect(mockRunEventTriggerPreview).not.toHaveBeenCalled();
  });

  it("returns 429 without previewing when rate limited", async () => {
    mockCheckRateLimit.mockReturnValue({
      allowed: false,
      limit: 60,
      remaining: 0,
      reset: 1_800_000_000,
    });

    const response = await POST(
      makeRequest(WORKFLOW_ID),
      makeParams(WORKFLOW_ID)
    );

    expect(response.status).toBe(429);
    expect(mockRunEventTriggerPreview).not.toHaveBeenCalled();
  });

  it("returns 404 when the workflow does not exist", async () => {
    mockWorkflowRows = [];

    const response = await POST(makeRequest("missing"), makeParams("missing"));

    expect(response.status).toBe(404);
    expect(mockRunEventTriggerPreview).not.toHaveBeenCalled();
  });

  it("returns 403 when the caller lacks full access", async () => {
    mockGetWorkflowAccess.mockResolvedValue({
      ...fullAccess,
      hasFullAccess: false,
    });

    const response = await POST(
      makeRequest(WORKFLOW_ID),
      makeParams(WORKFLOW_ID)
    );

    expect(response.status).toBe(403);
    expect(mockRunEventTriggerPreview).not.toHaveBeenCalled();
  });

  it("returns 410 for a soft-deleted workflow", async () => {
    mockGetWorkflowAccess.mockResolvedValue({
      ...fullAccess,
      isDeleted: true,
    });

    const response = await POST(
      makeRequest(WORKFLOW_ID),
      makeParams(WORKFLOW_ID)
    );

    expect(response.status).toBe(410);
    expect(mockRunEventTriggerPreview).not.toHaveBeenCalled();
  });

  it("passes a valid lookbackBlocks through", async () => {
    await POST(
      makeRequest(WORKFLOW_ID, { lookbackBlocks: 1200 }),
      makeParams(WORKFLOW_ID)
    );

    expect(mockRunEventTriggerPreview).toHaveBeenCalledWith(
      expect.objectContaining({ lookbackBlocks: 1200 })
    );
  });

  it.each([
    ["zero", 0],
    ["negative", -5],
    ["fractional", 12.5],
    ["beyond the ceiling", 50_001],
    ["a string", "5000"],
  ])("rejects a lookbackBlocks that is %s", async (_label, value) => {
    const response = await POST(
      makeRequest(WORKFLOW_ID, { lookbackBlocks: value }),
      makeParams(WORKFLOW_ID)
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: "INVALID_LOOKBACK_BLOCKS",
      maxLookbackBlocks: 50_000,
    });
    expect(mockRunEventTriggerPreview).not.toHaveBeenCalled();
  });

  it("treats an unparseable body as no override rather than an error", async () => {
    const request = new NextRequest(
      `http://localhost:3000/api/workflows/${WORKFLOW_ID}/trigger-preview`,
      {
        method: "POST",
        body: "not json",
        headers: { "content-type": "application/json" },
      }
    );

    const response = await POST(request, makeParams(WORKFLOW_ID));

    expect(response.status).toBe(200);
    expect(mockRunEventTriggerPreview).toHaveBeenCalledWith(
      expect.objectContaining({ lookbackBlocks: undefined })
    );
  });
});
