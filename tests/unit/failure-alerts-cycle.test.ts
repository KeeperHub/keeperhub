import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A query recorder standing in for drizzle: every chain resolves through `answer`.
const fake = vi.hoisted(() => {
  type Op = {
    kind: "select" | "update" | "insert" | "delete" | "execute";
    via: "db" | "tx";
    table?: unknown;
    sets?: unknown;
    query?: unknown;
    where?: unknown;
    orderBy?: unknown[];
  };
  const state = {
    ops: [] as Op[],
    answer: (_op: Op): unknown => [],
  };

  function chain(op: Op): unknown {
    const proxy: unknown = new Proxy(() => undefined, {
      get(_target, prop) {
        if (prop === "then") {
          return (
            resolve: (value: unknown) => unknown,
            reject: (error: unknown) => unknown
          ) => {
            try {
              return Promise.resolve(state.answer(op)).then(resolve, reject);
            } catch (error) {
              return Promise.reject(error).then(resolve, reject);
            }
          };
        }
        return (...args: unknown[]) => {
          if (prop === "from") {
            op.table = args[0];
          }
          if (prop === "set" || prop === "values") {
            op.sets = args[0];
          }
          if (prop === "where") {
            op.where = args[0];
          }
          if (prop === "orderBy") {
            op.orderBy = args;
          }
          return proxy;
        };
      },
    });
    return proxy;
  }

  function handle(via: "db" | "tx") {
    const start = (kind: Op["kind"], table?: unknown) => {
      const op: Op = { kind, via, table };
      state.ops.push(op);
      return chain(op);
    };
    return {
      select: () => start("select"),
      update: (table: unknown) => start("update", table),
      insert: (table: unknown) => start("insert", table),
      delete: (table: unknown) => start("delete", table),
      execute: (query: unknown) => {
        const op: Op = { kind: "execute", via, query };
        state.ops.push(op);
        return Promise.resolve(state.answer(op));
      },
    };
  }

  const tx = handle("tx");
  const db = {
    ...handle("db"),
    transaction: async (run: (t: typeof tx) => Promise<unknown>) =>
      await run(tx),
  };
  return { state, db, tx };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: fake.db }));
vi.mock("@/lib/logging", () => ({
  ErrorCategory: new Proxy({}, { get: (_t, prop) => String(prop) }),
  logSystemError: vi.fn(),
  logSystemWarn: vi.fn(),
  logInfo: vi.fn(),
}));
vi.mock("@/lib/billing/plans-server", () => ({
  getOrgPlan: vi.fn(async () => "pro"),
}));
vi.mock("@/lib/notifications/org-recipients", () => ({
  loadOrgMembers: vi.fn(async () => []),
}));
vi.mock("@/lib/notifications/failure-alerts/settings", () => ({
  isReachable: vi.fn(() => true),
  loadChannelViews: vi.fn(async () => []),
  lockOrgSettings: vi.fn(async () => undefined),
}));
vi.mock("@/lib/notifications/failure-alerts/senders", () => ({
  sendEmailMessage: vi.fn(async () => ({ ok: true, channelHealthy: true })),
  sendChannelMessage: vi.fn(async () => ({ ok: true, channelHealthy: true })),
  checkChannelSilently: vi.fn(async () => ({ ok: true, channelHealthy: true })),
}));
vi.mock("@/lib/notifications/failure-alerts/policy", () => ({
  ensureOrgSettings: vi.fn(async () => undefined),
  isMuted: vi.fn(() => false),
  loadChannels: vi.fn(async () => []),
  loadChannelsByIds: vi.fn(async () => new Map()),
  loadEffectivePolicy: vi.fn(async () => ({
    remindDaily: true,
    orgPausedUntil: null,
    channels: [],
    recipientUserIds: null,
  })),
  loadOrgPolicy: vi.fn(async () => ({
    recipientUserIds: null,
    countingSince: null,
    pausedUntil: null,
    threshold: 5,
  })),
  resolveRecipientEmails: vi.fn(() => []),
}));
vi.mock(
  "@/lib/notifications/failure-alerts/queue-rows",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/lib/notifications/failure-alerts/queue-rows")
    >()),
    insertDeliveries: vi.fn(async () => 1),
    rowsForPolicy: vi.fn(() => [{}]),
  })
);

const schema = await import("@/lib/db/schema");
const queueRows = await import("@/lib/notifications/failure-alerts/queue-rows");
const senders = await import("@/lib/notifications/failure-alerts/senders");
const {
  evaluateQueuedWorkflows,
  emptyStats,
  inactiveResolution,
  queueReminders,
} = await import("@/lib/notifications/failure-alerts/evaluator");
const { drainOutbox, emptyDrainStats, fireBackups, runHealthChecks } =
  await import("@/lib/notifications/failure-alerts/outbox");

const now = new Date("2026-11-04T12:00:00Z");
const savedRollout = process.env.FAILURE_ALERTS_ROLLOUT;

beforeEach(() => {
  fake.state.ops.length = 0;
  fake.state.answer = () => [];
  process.env.FAILURE_ALERTS_ROLLOUT = "orgs:in";
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env.FAILURE_ALERTS_ROLLOUT = savedRollout;
});

const opsOn = (kind: string, table: unknown) =>
  fake.state.ops.filter((op) => op.kind === kind && op.table === table);

describe("inactiveResolution", () => {
  const live = {
    deletedAt: null,
    deactivatedAt: null,
    enabled: true,
    orgDeactivatedAt: null,
  };

  it("treats a deactivated org like a paused workflow", () => {
    expect(inactiveResolution(live, "Schedule")).toBeNull();
    expect(
      inactiveResolution({ ...live, orgDeactivatedAt: now }, "Schedule")
    ).toBe("disabled");
  });
});

describe("queueReminders", () => {
  const dueRow = (patch: Record<string, unknown> = {}) => ({
    incident: {
      id: "inc",
      organizationId: "in",
      workflowId: "wf",
      reminderCount: 1,
      workflowPausedAt: null,
      workflowResumedAt: null,
    },
    enabled: true,
    deletedAt: null,
    deactivatedAt: null,
    nodes: [{ data: { type: "trigger", config: { triggerType: "Schedule" } } }],
    orgDeactivatedAt: null,
    orgHaltedAt: null,
    ...patch,
  });

  function answerWith(row: ReturnType<typeof dueRow>): void {
    fake.state.answer = (op) => {
      if (op.kind === "select") {
        return [row];
      }
      if (op.kind === "update" && op.via === "tx") {
        return [{ id: "inc" }];
      }
      return [];
    };
  }

  it("claims the reminder and queues its rows in one transaction", async () => {
    answerWith(dueRow());
    const stats = emptyStats();
    await queueReminders(now, stats);
    const claim = opsOn("update", schema.workflowFailureIncidents);
    expect(claim).toHaveLength(1);
    expect(claim[0]?.via).toBe("tx");
    expect(vi.mocked(queueRows.insertDeliveries).mock.calls[0]?.[1]).toBe(
      fake.tx
    );
    expect(stats.remindersQueued).toBe(1);
  });

  it("counts nothing when the insert fails, so the rolled-back claim is tried again", async () => {
    answerWith(dueRow());
    vi.mocked(queueRows.insertDeliveries).mockRejectedValueOnce(
      new Error("insert failed")
    );
    const stats = emptyStats();
    await queueReminders(now, stats);
    expect(
      opsOn("update", schema.workflowFailureIncidents).every(
        (op) => op.via === "tx"
      )
    ).toBe(true);
    expect(stats.remindersQueued).toBe(0);
  });

  it.each([
    ["deactivated", { orgDeactivatedAt: now }],
    ["halted", { orgHaltedAt: now }],
  ])(
    "sends no reminder for a %s org, only moves its clock",
    async (_label, patch) => {
      answerWith(dueRow(patch));
      const stats = emptyStats();
      await queueReminders(now, stats);
      const updates = opsOn("update", schema.workflowFailureIncidents);
      expect(updates).toHaveLength(1);
      expect(updates[0]?.via).toBe("db");
      expect(updates[0]?.sets).toEqual({ lastNotifiedAt: now });
      expect(queueRows.insertDeliveries).not.toHaveBeenCalled();
      expect(stats.remindersQueued).toBe(0);
    }
  );
});

describe("evaluateQueuedWorkflows", () => {
  const claimed = (count: number, prefix: string) =>
    Array.from({ length: count }, (_, i) => ({
      workflow_id: `${prefix}${i}`,
      lease: "2026-11-04 12:05:00",
    }));

  it("drops rows of orgs outside the rollout in bulk and claims the next batch", async () => {
    let executes = 0;
    fake.state.answer = (op) => {
      if (op.kind === "execute") {
        executes += 1;
        return executes === 1 ? claimed(500, "out") : [];
      }
      if (op.kind === "select" && op.table === schema.workflows) {
        return claimed(500, "out").map((row) => ({
          id: row.workflow_id,
          organizationId: "out",
        }));
      }
      return [];
    };
    await evaluateQueuedWorkflows(now, emptyStats(), Date.now() + 60_000);
    // claim, one bulk delete, claim (empty): no workflow is loaded one by one.
    expect(executes).toBe(3);
    expect(opsOn("select", schema.workflows)).toHaveLength(1);
  });

  it("never claims a workflow twice in one cycle", async () => {
    const queries: unknown[] = [];
    fake.state.answer = (op) => {
      if (op.kind === "execute") {
        queries.push(op.query);
        return queries.length === 1 ? claimed(500, "out") : [];
      }
      if (op.kind === "select" && op.table === schema.workflows) {
        return [];
      }
      return [];
    };
    await evaluateQueuedWorkflows(now, emptyStats(), Date.now() + 60_000);
    const dialect = new PgDialect();
    const [first, , second] = queries.map(
      (query) => dialect.sqlToQuery(query as SQL).params
    );
    expect(first).not.toContain("out0");
    expect(second).toContain("out0");
    expect(second).toContain("out499");
  });

  it("hands back what the budget did not reach", async () => {
    const clock = vi.spyOn(Date, "now");
    // Cycle start and the loop check fall inside the budget, then it runs out.
    clock
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(100);
    let executes = 0;
    fake.state.answer = (op) => {
      if (op.kind === "execute") {
        executes += 1;
        return executes === 1 ? claimed(2, "in") : [];
      }
      if (op.kind === "select" && op.table === schema.workflows) {
        return claimed(2, "in").map((row) => ({
          id: row.workflow_id,
          organizationId: "in",
        }));
      }
      return [];
    };
    await evaluateQueuedWorkflows(now, emptyStats(), 50);
    // The claim, then one hand-back; nothing was evaluated.
    expect(executes).toBe(2);
    expect(opsOn("select", schema.workflows)).toHaveLength(1);
  });
});

describe("drainOutbox", () => {
  const delivery = (
    id: string,
    organizationId: string,
    recipient: string,
    createdAt: Date = new Date()
  ) => ({
    id,
    organizationId,
    incidentId: "inc",
    kind: "alert",
    sequence: 0,
    channel: "email",
    channelId: null,
    recipient,
    context: null,
    attempts: 0,
    isBackup: false,
    backupAt: null,
    createdAt,
    state: "sending",
  });

  it("drops a row queued over an hour ago instead of sending it", async () => {
    let claims = 0;
    const old = new Date(Date.now() - 61 * 60 * 1000);
    fake.state.answer = (op) => {
      if (op.kind === "execute") {
        claims += 1;
        return claims === 1 ? [{ id: "d1" }, { id: "d2" }] : [];
      }
      if (op.kind === "select" && op.table === schema.failureAlertDeliveries) {
        return [
          delivery("d1", "in", "a@x.dev", old),
          delivery(
            "d2",
            "in",
            "b@x.dev",
            new Date(Date.now() - 59 * 60 * 1000)
          ),
        ];
      }
      return [];
    };
    await drainOutbox("http://app", emptyDrainStats(), Date.now() + 60_000);
    const dropped = opsOn("update", schema.failureAlertDeliveries).filter(
      (op) =>
        (op.sets as { lastError?: string })?.lastError ===
        "Dropped: queued more than an hour ago."
    );
    expect(dropped).toHaveLength(1);
    expect(
      vi.mocked(senders.sendEmailMessage).mock.calls.map((call) => call[0])
    ).not.toContain("a@x.dev");
  });

  it("skips rows of orgs outside the rollout and reads the run history once per incident", async () => {
    let claims = 0;
    fake.state.answer = (op) => {
      if (op.kind === "execute") {
        claims += 1;
        return claims === 1 ? [{ id: "d1" }, { id: "d2" }, { id: "d3" }] : [];
      }
      if (op.kind !== "select") {
        return [];
      }
      switch (op.table) {
        case schema.failureAlertDeliveries:
          return [
            delivery("d1", "in", "a@x.dev"),
            delivery("d2", "in", "b@x.dev"),
            delivery("d3", "out", "c@x.dev"),
          ];
        case schema.organization:
          return [{ name: "Acme" }];
        case schema.workflowFailureIncidents:
          return [
            {
              id: "inc",
              organizationId: "in",
              workflowId: "wf",
              failureCount: 5,
              firstFailedAt: now,
              lastError: "boom",
              openedBy: "count",
              resolvedAt: null,
              workflowPausedAt: null,
            },
          ];
        case schema.workflows:
          return [{ id: "wf", name: "Keeper", nodes: [] }];
        case schema.workflowExecutions:
          return [{ successes: 3, lastSuccessAt: null }];
        default:
          return [];
      }
    };
    await drainOutbox("http://app", emptyDrainStats(), Date.now() + 60_000);

    expect(senders.sendEmailMessage).toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(senders.sendEmailMessage).mock.calls.map((call) => call[0])
    ).toEqual(["a@x.dev", "b@x.dev"]);
    expect(opsOn("select", schema.workflowExecutions)).toHaveLength(1);
    const skipped = opsOn("update", schema.failureAlertDeliveries).filter(
      (op) => (op.sets as { state?: string })?.state === "skipped"
    );
    expect(skipped).toHaveLength(1);
  });
});

describe("fireBackups", () => {
  it("reads the oldest due backups first", async () => {
    await fireBackups(now, emptyDrainStats());
    const [read] = opsOn("select", schema.failureAlertDeliveries);
    expect(read?.orderBy).toEqual([schema.failureAlertDeliveries.backupAt]);
  });
});

describe("runHealthChecks", () => {
  it("checks no channel of an org outside the rollout", async () => {
    fake.state.answer = (op) =>
      op.kind === "select" ? [{ organizationId: "out" }] : [];
    await runHealthChecks(now, emptyDrainStats());
    expect(senders.checkChannelSilently).not.toHaveBeenCalled();
    expect(opsOn("select", schema.failureAlertChannels)).toHaveLength(1);
  });

  const channel = (id: string, organizationId: string) => ({
    id,
    organizationId,
    kind: "telegram",
    integrationId: "i1",
    destination: "-1001",
    role: "always",
    pausedAt: null,
  });

  it("checks the due channels of orgs in the rollout", async () => {
    fake.state.answer = (op) =>
      op.kind === "select" ? [channel("c0", "out"), channel("c1", "in")] : [];
    const stats = emptyDrainStats();
    await runHealthChecks(now, stats);
    expect(senders.checkChannelSilently).toHaveBeenCalledTimes(1);
    expect(stats.healthChecks).toBe(1);
  });

  it("pages past channels outside the rollout instead of rereading them", async () => {
    const page = Array.from({ length: 500 }, (_, i) =>
      channel(`c${String(i).padStart(3, "0")}`, "out")
    );
    const wheres: unknown[] = [];
    fake.state.answer = (op) => {
      if (op.kind !== "select") {
        return [];
      }
      wheres.push(op.where);
      return wheres.length === 1 ? page : [];
    };
    await runHealthChecks(now, emptyDrainStats());
    await runHealthChecks(now, emptyDrainStats());
    await runHealthChecks(now, emptyDrainStats());
    const dialect = new PgDialect();
    const params = wheres.map(
      (where) => dialect.sqlToQuery(where as SQL).params
    );
    expect(params[0]).not.toContain("c499");
    expect(params[1]).toContain("c499");
    // An empty page wraps back to the top.
    expect(params[2]).not.toContain("c499");
  });
});
