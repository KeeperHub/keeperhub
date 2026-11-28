import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const findManyMock = vi.fn();
const findFirstMock = vi.fn();
const loadWaitingMock = vi.fn();

// The summary view's bounded count: select().from(select().from().where().limit().as()).
const countQuery = () => ({
  from: () =>
    Object.assign(Promise.resolve([{ total: 3 }]), {
      where: () => ({ limit: () => ({ as: () => ({}) }) }),
    }),
});

vi.mock("@/lib/db", () => ({
  db: {
    select: () => countQuery(),
    query: {
      workflows: { findFirst: findFirstMock },
      workflowExecutions: { findMany: findManyMock },
    },
  },
}));
vi.mock("@/lib/middleware/auth-helpers", () => ({
  getDualAuthContext: vi.fn().mockResolvedValue({
    userId: "user_1",
    organizationId: null,
    authMethod: "session",
  }),
}));
vi.mock("@/lib/workflow/access", () => ({
  getWorkflowAccess: vi.fn().mockResolvedValue({
    hasFullAccess: true,
    canEdit: true,
    isDeleted: false,
  }),
}));
vi.mock("@/lib/workflow/executor/waiting-runs", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/workflow/executor/waiting-runs")
  >()),
  loadWaitingRunInfo: (...args: unknown[]) => loadWaitingMock(...args),
}));

import { RUN_OUTCOME_REASON } from "@/lib/workflow/executor/run-outcome-keys";

const INFO = {
  notBefore: 1_796_126_400,
  firstAllowedBlock: 21_400_421,
  latestBlock: 21_400_159,
  sendAheadBlocks: 2,
};

const rows = () => [
  {
    id: "wait_1",
    workflowId: "wf_1",
    status: "skipped",
    error: RUN_OUTCOME_REASON.waiting,
    errorCode: "bundle-waiting",
  },
  {
    id: "skip_1",
    workflowId: "wf_1",
    status: "skipped",
    error: RUN_OUTCOME_REASON.skipped,
  },
  { id: "ok_1", workflowId: "wf_1", status: "success", error: null },
];

describe("runs list: skipReason and waiting, for grouping waiting runs", () => {
  it.each([
    ["full list", "http://test/executions"],
    ["summary view", "http://test/executions?view=summary"],
  ])(
    "the %s keys each run and carries a waiting run's outputs",
    async (_name, url) => {
      findFirstMock.mockResolvedValueOnce({ id: "wf_1", userId: "user_1" });
      findManyMock.mockResolvedValueOnce(
        rows().map((row) => ({
          ...row,
          startedAtKey: "2026-11-27 00:00:00.000000",
        }))
      );
      loadWaitingMock.mockResolvedValueOnce(new Map([["wait_1", INFO]]));
      const { GET } = await import(
        "@/app/api/workflows/[workflowId]/executions/route"
      );
      const response = await GET(new Request(url), {
        params: Promise.resolve({ workflowId: "wf_1" }),
      });
      const body = (await response.json()) as
        | Record<string, unknown>[]
        | { executions: Record<string, unknown>[] };
      const runs = Array.isArray(body) ? body : body.executions;
      expect(runs.map((run) => [run.id, run.skipReason, run.waiting])).toEqual([
        ["wait_1", "bundle-waiting", INFO],
        ["skip_1", "bundle-in-flight", null],
        ["ok_1", null, null],
      ]);
      expect(loadWaitingMock).toHaveBeenLastCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            id: "wait_1",
            skipReason: "bundle-waiting",
          }),
        ])
      );
    }
  );
});
