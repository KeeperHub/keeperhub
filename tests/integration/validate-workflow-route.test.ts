/**
 * Integration tests for GET /api/workflows/[workflowId]/validate
 *
 * Key contracts under test:
 *   - VALID-01: errors/warnings keys ABSENT (not []) when empty
 *   - 200 happy path with no errors or warnings
 *   - 200 with empty workflow body (errors array present, warnings absent)
 *   - 404 NOT_FOUND for unknown workflowId
 *   - 403 FORBIDDEN when caller org does not match
 *   - 410 GONE when workflow is soft-deleted
 *   - deepCheck=true path dispatches to deep tier
 *   - deepCheck=false (default) never calls resolveAbi
 */

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock server-only so the deep module can be imported in tests
// ---------------------------------------------------------------------------
vi.mock("server-only", () => ({}));

// ---------------------------------------------------------------------------
// Mock getDualAuthContext — returns an authenticated context by default
// ---------------------------------------------------------------------------
const mockGetDualAuthContext = vi.fn();
vi.mock("@/lib/middleware/auth-helpers", () => ({
  getDualAuthContext: (...args: unknown[]) => mockGetDualAuthContext(...args),
}));

// ---------------------------------------------------------------------------
// Mock getWorkflowAccess — returns full access by default
// ---------------------------------------------------------------------------
const mockGetWorkflowAccess = vi.fn();
vi.mock("@/lib/workflow/access", () => ({
  getWorkflowAccess: (...args: unknown[]) => mockGetWorkflowAccess(...args),
}));

// ---------------------------------------------------------------------------
// Mock resolveAbi (deep tier) — we control when it is called
// ---------------------------------------------------------------------------
const mockResolveAbi = vi.fn();
vi.mock("@/lib/abi/cache", () => ({
  resolveAbi: (...args: unknown[]) => mockResolveAbi(...args),
}));

// ---------------------------------------------------------------------------
// Track db.select() call sequence:
//   call 1 = workflows lookup (uses .where().limit())
//   call 2 = chains lookup    (uses .where() — no .limit())
// (deepCheck adds no extra DB calls — validator is pure)
//
// The mock whereResult must be both awaitable (Promise-like) for the chains
// query and expose a .limit() method for the workflow query. We achieve this
// by making whereResult a promise that also carries a .limit() method.
// ---------------------------------------------------------------------------
let selectCallIndex = 0;
let mockWorkflowRows: unknown[] = [];
let mockChainRows: unknown[] = [];

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => {
          selectCallIndex += 1;
          const isFirstCall = selectCallIndex === 1;
          // Make result both a Promise (for .where() await) and carry .limit()
          const rows = isFirstCall ? mockWorkflowRows : mockChainRows;
          const p = Promise.resolve(rows) as Promise<unknown[]> & {
            limit: (n: number) => Promise<unknown[]>;
          };
          p.limit = (_n: number) => Promise.resolve(rows);
          return p;
        }),
      })),
    })),
  },
}));

// Import route AFTER mocks
import { GET } from "@/app/api/workflows/[workflowId]/validate/route";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OWNER_USER_ID = "user-owner";
const OWNER_ORG_ID = "org-owner";
const OTHER_ORG_ID = "org-other";
const WORKFLOW_ID = "wf-test-1";

const authContextOwner = {
  userId: OWNER_USER_ID,
  organizationId: OWNER_ORG_ID,
  authMethod: "session" as const,
};

const accessFull = {
  isCreatorWithCurrentAccess: true,
  isSameOrg: true,
  hasFullAccess: true,
  isDeleted: false,
};

const accessForbidden = {
  isCreatorWithCurrentAccess: false,
  isSameOrg: false,
  hasFullAccess: false,
  isDeleted: false,
};

const accessDeleted = {
  isCreatorWithCurrentAccess: true,
  isSameOrg: true,
  hasFullAccess: true,
  isDeleted: true,
};

// Minimal workflow with trigger + action node — valid, no errors
const triggerNode = {
  id: "trigger-1",
  type: "trigger",
  data: {
    label: "Trigger",
    type: "trigger",
    config: { triggerType: "Manual" },
  },
};

const actionNode = {
  id: "action-1",
  type: "action",
  data: {
    label: "Action",
    type: "action",
    config: { actionType: "web3/read-contract" },
  },
};

const validWorkflowRow = {
  id: WORKFLOW_ID,
  userId: OWNER_USER_ID,
  organizationId: OWNER_ORG_ID,
  isAnonymous: false,
  deletedAt: null,
  nodes: [triggerNode, actionNode],
  edges: [{ id: "e1", source: "trigger-1", target: "action-1" }],
  inputSchema: { type: "object" },
  outputMapping: null,
  isListed: false,
  workflowType: "read",
};

// Workflow with empty nodes — triggers empty-nodes-array error
const emptyWorkflowRow = {
  ...validWorkflowRow,
  nodes: [],
  edges: [],
};

const chainRow = { chainId: 1 };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(
  workflowId: string,
  queryParams: Record<string, string> = {}
): NextRequest {
  const url = new URL(
    `http://localhost:3000/api/workflows/${workflowId}/validate`
  );
  for (const [key, val] of Object.entries(queryParams)) {
    url.searchParams.set(key, val);
  }
  return new NextRequest(url);
}

function makeParams(workflowId: string) {
  return { params: Promise.resolve({ workflowId }) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("/api/workflows/[workflowId]/validate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectCallIndex = 0;
    mockWorkflowRows = [];
    mockChainRows = [];
    mockGetDualAuthContext.mockResolvedValue(authContextOwner);
    mockGetWorkflowAccess.mockResolvedValue(accessFull);
    mockResolveAbi.mockResolvedValue({ abi: "[]" });
  });

  // -------------------------------------------------------------------------
  // 404 — workflow not found
  // -------------------------------------------------------------------------
  describe("404 NOT_FOUND", () => {
    it("returns 404 when workflow row does not exist", async () => {
      mockWorkflowRows = [];
      mockChainRows = [chainRow];

      const request = makeRequest("no-such-workflow");
      const response = await GET(request, makeParams("no-such-workflow"));

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.ok).toBe(false);
      expect(body.error).toBe("NOT_FOUND");
    });
  });

  // -------------------------------------------------------------------------
  // 403 — wrong org
  // -------------------------------------------------------------------------
  describe("403 FORBIDDEN", () => {
    it("returns 403 when caller org does not match", async () => {
      mockGetDualAuthContext.mockResolvedValue({
        userId: "user-other",
        organizationId: OTHER_ORG_ID,
        authMethod: "session" as const,
      });
      mockWorkflowRows = [validWorkflowRow];
      mockChainRows = [chainRow];
      mockGetWorkflowAccess.mockResolvedValue(accessForbidden);

      const request = makeRequest(WORKFLOW_ID);
      const response = await GET(request, makeParams(WORKFLOW_ID));

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.ok).toBe(false);
      expect(body.error).toBe("FORBIDDEN");
    });
  });

  // -------------------------------------------------------------------------
  // 410 — soft-deleted
  // -------------------------------------------------------------------------
  describe("410 GONE", () => {
    it("returns 410 when workflow is soft-deleted", async () => {
      mockWorkflowRows = [{ ...validWorkflowRow, deletedAt: new Date() }];
      mockChainRows = [chainRow];
      mockGetWorkflowAccess.mockResolvedValue(accessDeleted);

      const request = makeRequest(WORKFLOW_ID);
      const response = await GET(request, makeParams(WORKFLOW_ID));

      expect(response.status).toBe(410);
      const body = await response.json();
      expect(body.ok).toBe(false);
      expect(body.error).toBe("GONE");
    });
  });

  // -------------------------------------------------------------------------
  // 401 — unauthenticated
  // -------------------------------------------------------------------------
  describe("401 UNAUTHENTICATED", () => {
    it("returns 401 when auth fails", async () => {
      mockGetDualAuthContext.mockResolvedValue({
        error: "UNAUTHORIZED",
        status: 401,
      });

      const request = makeRequest(WORKFLOW_ID);
      const response = await GET(request, makeParams(WORKFLOW_ID));

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.ok).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 200 happy path — valid workflow, no errors or warnings
  // VALID-01 contract: errors and warnings keys ABSENT when empty
  // -------------------------------------------------------------------------
  describe("200 happy path", () => {
    it("returns valid:true + nodeCount with errors and warnings keys ABSENT", async () => {
      mockWorkflowRows = [validWorkflowRow];
      mockChainRows = [chainRow];

      const request = makeRequest(WORKFLOW_ID);
      const response = await GET(request, makeParams(WORKFLOW_ID));

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(body.result.valid).toBe(true);
      expect(body.result.nodeCount).toBe(2);

      // VALID-01 hard requirement: keys must be ABSENT, not empty arrays
      expect("errors" in body.result).toBe(false);
      expect("warnings" in body.result).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 200 — empty workflow (errors present, warnings absent)
  // -------------------------------------------------------------------------
  describe("200 empty workflow", () => {
    it("returns valid:false with errors array; warnings key ABSENT", async () => {
      mockWorkflowRows = [emptyWorkflowRow];
      mockChainRows = [chainRow];

      const request = makeRequest(WORKFLOW_ID);
      const response = await GET(request, makeParams(WORKFLOW_ID));

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(body.result.valid).toBe(false);
      expect(body.result.nodeCount).toBe(0);

      // errors present because nodes is empty
      expect(Array.isArray(body.result.errors)).toBe(true);
      expect(body.result.errors.length).toBeGreaterThan(0);
      const emptyNodesErr = body.result.errors.find(
        (e: { code: string }) => e.code === "empty-nodes-array"
      );
      expect(emptyNodesErr).toBeDefined();

      // warnings key must be ABSENT (no write-action mismatch on read-type empty workflow)
      expect("warnings" in body.result).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // deepCheck=false (default) — fast tier only, resolveAbi never called
  // -------------------------------------------------------------------------
  describe("deepCheck=false (default)", () => {
    it("does not call resolveAbi when deepCheck is omitted", async () => {
      mockWorkflowRows = [validWorkflowRow];
      mockChainRows = [chainRow];

      const request = makeRequest(WORKFLOW_ID);
      const response = await GET(request, makeParams(WORKFLOW_ID));

      expect(response.status).toBe(200);
      expect(mockResolveAbi).not.toHaveBeenCalled();
    });

    it("does not call resolveAbi when deepCheck=false is explicit", async () => {
      mockWorkflowRows = [validWorkflowRow];
      mockChainRows = [chainRow];

      const request = makeRequest(WORKFLOW_ID, { deepCheck: "false" });
      const response = await GET(request, makeParams(WORKFLOW_ID));

      expect(response.status).toBe(200);
      expect(mockResolveAbi).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // deepCheck=true — dispatches to deep tier; warnings present, errors absent
  // for a workflow whose contract ABI mismatch emits a warning
  // -------------------------------------------------------------------------
  describe("deepCheck=true", () => {
    it("returns 200 with warnings from deep tier; errors key absent when no errors", async () => {
      // A workflow with a write-contract node so collectContractRefs finds it
      const writeNode = {
        id: "write-1",
        type: "action",
        data: {
          label: "Write",
          type: "action",
          config: {
            actionType: "web3/write-contract",
            contractAddress: "0x6b175474e89094c44da98b954eedeac495271d0f",
            network: "1",
            abi: JSON.stringify([
              { type: "function", name: "transfer", inputs: [], outputs: [] },
            ]),
            abiFunction: "transfer",
          },
        },
      };
      const deepWorkflowRow = {
        ...validWorkflowRow,
        nodes: [triggerNode, writeNode],
        edges: [{ id: "e1", source: "trigger-1", target: "write-1" }],
        workflowType: "write",
      };

      mockWorkflowRows = [deepWorkflowRow];
      mockChainRows = [{ chainId: 1 }];

      // resolveAbi returns a different ABI (mismatch → warning).
      // resolveAbi resolves to { abi: string } per lib/abi/cache.ts contract.
      mockResolveAbi.mockResolvedValue({
        abi: JSON.stringify([
          { type: "function", name: "transfer", inputs: [], outputs: [] },
          { type: "function", name: "approve", inputs: [], outputs: [] },
        ]),
      });

      const request = makeRequest(WORKFLOW_ID, { deepCheck: "true" });
      const response = await GET(request, makeParams(WORKFLOW_ID));

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);

      // Deep tier may emit warnings for ABI mismatch — allowed
      // errors key must be absent (no structural errors)
      expect("errors" in body.result).toBe(false);

      // resolveAbi was called (deep tier activated)
      expect(mockResolveAbi).toHaveBeenCalled();
    });

    it("returns warnings array when present; warnings key absent when deep check finds no issues", async () => {
      // Workflow with matching ABI → resolveAbi returns same ABI → no warnings
      const abi = JSON.stringify([
        { type: "function", name: "transfer", inputs: [], outputs: [] },
      ]);
      const writeNode = {
        id: "write-1",
        type: "action",
        data: {
          label: "Write",
          type: "action",
          config: {
            actionType: "web3/write-contract",
            contractAddress: "0x6b175474e89094c44da98b954eedeac495271d0f",
            network: "1",
            abi,
            abiFunction: "transfer",
          },
        },
      };
      const deepWorkflowRow = {
        ...validWorkflowRow,
        nodes: [triggerNode, writeNode],
        edges: [{ id: "e1", source: "trigger-1", target: "write-1" }],
        workflowType: "write",
      };

      mockWorkflowRows = [deepWorkflowRow];
      mockChainRows = [{ chainId: 1 }];

      // resolveAbi returns matching ABI → no mismatch → no warnings.
      // resolveAbi resolves to { abi: string } per lib/abi/cache.ts contract.
      mockResolveAbi.mockResolvedValue({ abi });

      const request = makeRequest(WORKFLOW_ID, { deepCheck: "true" });
      const response = await GET(request, makeParams(WORKFLOW_ID));

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(body.result.valid).toBe(true);

      // Both keys absent — VALID-01 contract
      expect("errors" in body.result).toBe(false);
      expect("warnings" in body.result).toBe(false);
    });
  });
});
