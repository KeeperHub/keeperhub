import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  authenticateInternalService: vi.fn(),
  loadWorkflowForExecution: vi.fn(),
}));

// No internal-service auth -> the route treats it as an interactive call and
// evaluates lifecycle via loadWorkflowForExecution, which we control.
vi.mock("@/lib/internal-service-auth", () => ({
  authenticateInternalService: (...args: unknown[]) =>
    mocks.authenticateInternalService(...args),
}));

vi.mock("@/lib/workflow/load-for-execution", () => ({
  loadWorkflowForExecution: (...args: unknown[]) =>
    mocks.loadWorkflowForExecution(...args),
}));

import { POST } from "@/app/api/workflow/[workflowId]/execute/route";

function postRequest() {
  return new Request("http://localhost/api/workflow/wf-1/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
}

const context = { params: Promise.resolve({ workflowId: "wf-1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authenticateInternalService.mockResolvedValue({ authenticated: false });
});

describe("POST /api/workflow/[workflowId]/execute lifecycle mapping", () => {
  it("returns 503 (not 404) when the owning org is halted", async () => {
    mocks.loadWorkflowForExecution.mockResolvedValue({
      status: "not_executable",
      reason: "halted",
    });

    const res = await POST(postRequest(), context);

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Workflow temporarily halted" });
  });

  it("still returns 404 for a genuinely missing workflow", async () => {
    mocks.loadWorkflowForExecution.mockResolvedValue({ status: "not_found" });

    const res = await POST(postRequest(), context);

    expect(res.status).toBe(404);
  });
});
