import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/logging", () => ({
  ErrorCategory: { WORKFLOW_ENGINE: "workflow_engine" },
  logSystemError: vi.fn(),
}));
vi.mock("@/lib/metrics/instrumentation/workflow", () => ({
  recordStepMetrics: vi.fn(),
}));
vi.mock("@/lib/workflow/executor/logging", () => ({
  incrementCompletedSteps: vi.fn(),
  logStepCompleteDb: vi.fn(),
  logStepStartDb: vi.fn(),
  logWorkflowCompleteDb: vi.fn(),
  updateCurrentStep: vi.fn(),
}));

import { recordStepMetrics } from "@/lib/metrics/instrumentation/workflow";
import {
  logStepCompleteDb,
  logStepStartDb,
} from "@/lib/workflow/executor/logging";
import {
  type StepContext,
  withStepLogging,
} from "@/lib/workflow/executor/step-handler";

const FAKE_DRPC_KEY = "FAKE_TEST_KEY_DO_NOT_USE_AAAAAAAAAAAAAAAAAAAA";
const KEYED_URL = `https://lb.drpc.live/ethereum/${FAKE_DRPC_KEY}`;

const web3Context: StepContext = {
  executionId: "exec-1",
  nodeId: "node-1",
  nodeName: "Query Poke Events",
  nodeType: "web3/query-events",
};

const webhookContext: StepContext = {
  executionId: "exec-1",
  nodeId: "node-2",
  nodeName: "Notify",
  nodeType: "webhook/send-webhook",
};

describe("withStepLogging error redaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(logStepStartDb).mockResolvedValue({
      logId: "log-1",
      startTime: Date.now(),
    });
  });

  it("drops entire provider URLs (host included) from web3 step error results", async () => {
    const rawError = `Event query failed: RPC failed on both endpoints. Fallback: server response 400 Bad Request (info={ "requestUrl": "${KEYED_URL}" })`;

    const result = await withStepLogging({ _context: web3Context }, () =>
      Promise.resolve({ success: false, error: rawError })
    );

    expect(result.error).not.toContain(FAKE_DRPC_KEY);
    expect(result.error).not.toContain("lb.drpc.live");
    expect(result.error).toContain("[REDACTED-URL]");
    expect(result.error).toContain("RPC failed on both endpoints");

    expect(logStepCompleteDb).toHaveBeenCalledTimes(1);
    const persisted = vi.mocked(logStepCompleteDb).mock.calls[0][0];
    expect(persisted.error).not.toContain("lb.drpc.live");
    // The result object is persisted whole as output/outputRaw; its error
    // field must carry the redacted string too.
    expect((persisted.outputRaw as { error: string }).error).not.toContain(
      "lb.drpc.live"
    );
    expect((persisted.output as { error: string }).error).not.toContain(
      "lb.drpc.live"
    );

    const metrics = vi.mocked(recordStepMetrics).mock.calls[0][0];
    expect(metrics.error).not.toContain("lb.drpc.live");
  });

  it("keeps user-owned URLs in non-web3 step errors while dropping keyed ones", async () => {
    const rawError = `Failed to send webhook: https://users-own-site.com/hook returned 502 (upstream ${KEYED_URL})`;

    const result = await withStepLogging({ _context: webhookContext }, () =>
      Promise.resolve({ success: false, error: rawError })
    );

    expect(result.error).toContain("https://users-own-site.com/hook");
    expect(result.error).not.toContain(FAKE_DRPC_KEY);
    expect(result.error).not.toContain("lb.drpc.live");
    expect(result.error).toContain("[REDACTED-URL]");
  });

  it("redacts thrown web3 step errors and rethrows with the clean message", async () => {
    const thrown = new Error(
      `could not coalesce error (info={ "requestUrl": "${KEYED_URL}" }, code=UNKNOWN_ERROR, version=6.16.0)`
    );

    await expect(
      withStepLogging({ _context: web3Context }, () => Promise.reject(thrown))
    ).rejects.toSatisfy((error: unknown) => {
      const message = (error as Error).message;
      expect(message).not.toContain(FAKE_DRPC_KEY);
      expect(message).not.toContain("lb.drpc.live");
      expect(message).toContain("[REDACTED-URL]");
      return true;
    });

    expect(logStepCompleteDb).toHaveBeenCalledTimes(1);
    const persisted = vi.mocked(logStepCompleteDb).mock.calls[0][0];
    expect(persisted.error).not.toContain("lb.drpc.live");
  });

  it("does not redact a success-carrying error (softened failOnError result)", async () => {
    const rawError = `Contract call failed: could not coalesce error (info={ "requestUrl": "${KEYED_URL}" }, code=UNKNOWN_ERROR)`;

    const result = await withStepLogging({ _context: web3Context }, () =>
      Promise.resolve({ success: true, error: rawError })
    );

    // withStepLogging only redacts the success: false branch. A softened
    // write-contract result (failOnError=false) is success: true, so it
    // gets no redaction here; applyFailOnError in write-contract-core.ts
    // must redact it before it ever reaches this point.
    expect(result.error).toBe(rawError);
  });

  it("survives frozen thrown errors without masking the failure", async () => {
    const frozen = Object.freeze(
      new Error(`fetch ${KEYED_URL} failed with 401`)
    );

    await expect(
      withStepLogging({ _context: web3Context }, () => Promise.reject(frozen))
    ).rejects.toBe(frozen);
  });
});
