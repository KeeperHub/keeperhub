import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const {
  mockAuthenticateAdmin,
  mockFindWorkflow,
  mockFindUser,
  mockUpdate,
  mockSyncSchedule,
} = vi.hoisted(() => ({
  mockAuthenticateAdmin: vi.fn(),
  mockFindWorkflow: vi.fn(),
  mockFindUser: vi.fn(),
  mockUpdate: vi.fn(),
  mockSyncSchedule: vi.fn(),
}));

vi.mock("@/lib/admin-auth", () => ({
  authenticateAdmin: mockAuthenticateAdmin,
}));

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      workflows: {
        findFirst: (...args: unknown[]) => mockFindWorkflow(...args),
      },
      users: {
        findFirst: (...args: unknown[]) => mockFindUser(...args),
      },
    },
    update: () => ({
      set: () => ({
        where: (...args: unknown[]) => mockUpdate(...args),
      }),
    }),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  workflows: { id: "workflows.id" },
  users: { id: "users.id" },
}));

vi.mock("@/lib/schedule-service", () => ({
  syncWorkflowSchedule: (...args: unknown[]) => mockSyncSchedule(...args),
}));

vi.mock("drizzle-orm", () => ({
  eq: (a: unknown, b: unknown) => ({ a, b }),
}));

import { POST } from "@/app/api/admin/test/enable-workflow/route.staging";

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/admin/test/enable-workflow", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("POST /api/admin/test/enable-workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthenticateAdmin.mockReturnValue({ authenticated: true });
    mockUpdate.mockResolvedValue(undefined);
    mockSyncSchedule.mockResolvedValue({ ok: true });
  });

  it("returns 401 when admin auth fails", async () => {
    mockAuthenticateAdmin.mockReturnValue({
      authenticated: false,
      error: "nope",
    });
    const res = await POST(makeRequest({ workflowId: "wf_1" }));
    expect(res.status).toBe(401);
    expect(mockFindWorkflow).not.toHaveBeenCalled();
  });

  it("returns 400 when workflowId is missing", async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
  });

  it("returns 404 when workflow does not exist", async () => {
    mockFindWorkflow.mockResolvedValue(undefined);
    const res = await POST(makeRequest({ workflowId: "wf_missing" }));
    expect(res.status).toBe(404);
  });

  it("returns 403 when workflow owner is not a k6 test user", async () => {
    mockFindWorkflow.mockResolvedValue({
      id: "wf_1",
      userId: "u_1",
      nodes: [],
    });
    mockFindUser.mockResolvedValue({ email: "real-user@example.com" });
    const res = await POST(makeRequest({ workflowId: "wf_1" }));
    expect(res.status).toBe(403);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockSyncSchedule).not.toHaveBeenCalled();
  });

  it("returns 403 when owner email is null", async () => {
    mockFindWorkflow.mockResolvedValue({
      id: "wf_1",
      userId: "u_1",
      nodes: [],
    });
    mockFindUser.mockResolvedValue({ email: null });
    const res = await POST(makeRequest({ workflowId: "wf_1" }));
    expect(res.status).toBe(403);
  });

  it("returns 403 when owner has @techops.services email but no k6- prefix", async () => {
    mockFindWorkflow.mockResolvedValue({
      id: "wf_1",
      userId: "u_1",
      nodes: [],
    });
    mockFindUser.mockResolvedValue({ email: "ops@techops.services" });
    const res = await POST(makeRequest({ workflowId: "wf_1" }));
    expect(res.status).toBe(403);
  });

  it("enables and syncs the workflow when owner is a k6 user", async () => {
    mockFindWorkflow.mockResolvedValue({
      id: "wf_1",
      userId: "u_1",
      nodes: [{ id: "t" }],
    });
    mockFindUser.mockResolvedValue({ email: "k6-vu1-12345@techops.services" });
    const res = await POST(makeRequest({ workflowId: "wf_1" }));
    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockSyncSchedule).toHaveBeenCalledWith("wf_1", [{ id: "t" }]);
    const json = (await res.json()) as { enabled: boolean };
    expect(json.enabled).toBe(true);
  });

  // KEEP-581: hard sync failures (currently only interval_too_small)
  // surface as 400. Other sync failures (soft kind: invalid timezone,
  // invalid cron) keep the warn-and-200 behaviour exercised by the
  // happy-path test above.
  it("returns 400 SCHEDULE_INTERVAL_TOO_SMALL when sync fails with kind:hard", async () => {
    mockFindWorkflow.mockResolvedValue({
      id: "wf_1",
      userId: "u_1",
      nodes: [{ id: "t" }],
    });
    mockFindUser.mockResolvedValue({ email: "k6-vu1-12345@techops.services" });
    mockSyncSchedule.mockResolvedValue({
      synced: false,
      kind: "hard",
      code: "interval_too_small",
      error: "scheduleIntervalSeconds must be >= 60 (got 30)",
    });

    const res = await POST(makeRequest({ workflowId: "wf_1" }));

    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string; message: string };
    expect(json.error).toBe("SCHEDULE_INTERVAL_TOO_SMALL");
    expect(json.message).toContain(">= 60");
  });

  it("returns 200 (warn-and-continue) when sync fails with kind:soft", async () => {
    mockFindWorkflow.mockResolvedValue({
      id: "wf_1",
      userId: "u_1",
      nodes: [{ id: "t" }],
    });
    mockFindUser.mockResolvedValue({ email: "k6-vu1-12345@techops.services" });
    mockSyncSchedule.mockResolvedValue({
      synced: false,
      kind: "soft",
      error: "Invalid timezone: Mars/Olympus_Mons",
    });

    const res = await POST(makeRequest({ workflowId: "wf_1" }));

    // Soft failures are not promoted to 400; the workflow was still
    // enabled successfully, and the sync result is returned in the
    // body so the caller can decide what to do.
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      enabled: boolean;
      scheduleSync: unknown;
    };
    expect(json.enabled).toBe(true);
    expect(json.scheduleSync).toMatchObject({
      synced: false,
      kind: "soft",
    });
  });
});
