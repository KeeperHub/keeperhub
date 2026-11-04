import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/logging", () => ({
  ErrorCategory: new Proxy({}, { get: (_t, prop) => String(prop) }),
  logSystemError: vi.fn(),
  logSystemWarn: vi.fn(),
}));
vi.mock("@/lib/internal-service-auth", () => ({
  authenticateInternalService: vi.fn(async () => ({ authenticated: true })),
}));
vi.mock("@/lib/notifications/failure-alerts/messages", () => ({
  appBaseUrl: () => "https://app.test",
}));
vi.mock("@/lib/notifications/failure-alerts/rollout", () => ({
  isFailureAlertsRolloutActive: () => true,
}));
vi.mock("@/lib/notifications/failure-alerts/org-pause", () => ({
  endExpiredOrgPauses: vi.fn(async () => 0),
}));
vi.mock("@/lib/notifications/failure-alerts/evaluator", () => ({
  checkMissedSchedules: vi.fn(async () => undefined),
  clearQueueWhileOff: vi.fn(async () => undefined),
  closeInactiveIncidents: vi.fn(async () => undefined),
  emptyStats: () => ({}),
  evaluateQueuedWorkflows: vi.fn(async () => undefined),
  queueReminders: vi.fn(async () => undefined),
  requeueLostAlerts: vi.fn(async () => undefined),
}));
vi.mock("@/lib/notifications/failure-alerts/outbox", () => ({
  drainOutbox: vi.fn(async () => undefined),
  emptyDrainStats: () => ({}),
  fireBackups: vi.fn(async () => undefined),
  pruneOldRecords: vi.fn(async () => undefined),
  runHealthChecks: vi.fn(async () => undefined),
}));

const evaluator = await import("@/lib/notifications/failure-alerts/evaluator");
const outbox = await import("@/lib/notifications/failure-alerts/outbox");
const logging = await import("@/lib/logging");
const { GET } = await import("@/app/api/internal/failure-alerts/route");

const callCron = () =>
  GET(new Request("http://app.test/api/internal/failure-alerts"));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("failure alert cycle stages", () => {
  it("logs a failed health check or prune and keeps going, without failing the job", async () => {
    vi.mocked(outbox.runHealthChecks).mockRejectedValueOnce(new Error("probe"));
    vi.mocked(outbox.pruneOldRecords).mockRejectedValueOnce(new Error("prune"));
    const response = await callCron();
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.errors).toEqual([]);
    expect(body.warnings).toEqual(["health: probe", "prune: prune"]);
    expect(logging.logSystemError).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["evaluate", () => vi.mocked(evaluator.evaluateQueuedWorkflows)],
    ["deliver", () => vi.mocked(outbox.drainOutbox)],
  ])(
    "fails the job when the %s stage fails, after the rest ran",
    async (name, target) => {
      target().mockRejectedValueOnce(new Error("down"));
      const response = await callCron();
      const body = await response.json();
      expect(response.status).toBe(500);
      expect(body.errors).toEqual([`${name}: down`]);
      expect(outbox.pruneOldRecords).toHaveBeenCalledTimes(1);
    }
  );
});
