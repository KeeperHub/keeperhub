import { beforeEach, describe, expect, it, vi } from "vitest";

const { getAll, create, signInAnonymous } = vi.hoisted(() => ({
  getAll: vi.fn(),
  create: vi.fn(),
  signInAnonymous: vi.fn(),
}));

vi.mock("@/lib/api-client", () => ({
  api: { workflow: { getAll, create } },
}));
vi.mock("@/lib/auth-client", () => ({
  authClient: { signIn: { anonymous: signInAnonymous } },
}));

import { startNewWorkflow } from "@/lib/workflow/start-new-workflow";

beforeEach(() => {
  vi.clearAllMocks();
  create.mockResolvedValue({ id: "new" });
  getAll.mockResolvedValue([]);
});

describe("startNewWorkflow", () => {
  it("creates an empty workflow for a signed-in user", async () => {
    const started = await startNewWorkflow({
      isAnonymous: false,
      hasSession: true,
    });
    expect(started).toEqual({ id: "new", created: true });
    expect(create).toHaveBeenCalledWith({
      name: "Untitled Workflow",
      description: "",
      nodes: [],
      edges: [],
    });
    expect(getAll).not.toHaveBeenCalled();
    expect(signInAnonymous).not.toHaveBeenCalled();
  });

  it("signs a visitor in anonymously before creating", async () => {
    const started = await startNewWorkflow({
      isAnonymous: true,
      hasSession: false,
    });
    expect(signInAnonymous).toHaveBeenCalledOnce();
    expect(started).toEqual({ id: "new", created: true });
  });

  it("sends an anonymous user with a workflow to their latest one", async () => {
    getAll.mockResolvedValue([
      { id: "old", name: "A", updatedAt: "2026-10-01T00:00:00Z" },
      { id: "latest", name: "B", updatedAt: "2026-10-02T00:00:00Z" },
      { id: "scratch", name: "__current__", updatedAt: "2026-10-03T00:00:00Z" },
    ]);
    const started = await startNewWorkflow({
      isAnonymous: true,
      hasSession: true,
    });
    expect(started).toEqual({ id: "latest", created: false });
    expect(create).not.toHaveBeenCalled();
  });

  it("skips a deleted workflow when sending an anonymous user to theirs", async () => {
    getAll.mockResolvedValue([
      { id: "kept", name: "A", updatedAt: "2026-10-01T00:00:00Z" },
      {
        id: "deleted",
        name: "B",
        updatedAt: "2026-10-02T00:00:00Z",
        deletedAt: "2026-10-03T00:00:00Z",
      },
    ]);
    const started = await startNewWorkflow({
      isAnonymous: true,
      hasSession: true,
    });
    expect(started).toEqual({ id: "kept", created: false });
  });

  it("creates when listing an anonymous user's workflows fails", async () => {
    getAll.mockRejectedValue(new Error("offline"));
    const started = await startNewWorkflow({
      isAnonymous: true,
      hasSession: true,
    });
    expect(started).toEqual({ id: "new", created: true });
  });
});
