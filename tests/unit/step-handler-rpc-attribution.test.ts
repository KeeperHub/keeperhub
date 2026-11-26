import { AsyncLocalStorage } from "node:async_hooks";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/logging", () => ({
  ErrorCategory: { WORKFLOW_ENGINE: "workflow_engine" },
  logSystemError: vi.fn(),
  logSystemWarn: vi.fn(),
}));
vi.mock("@/lib/metrics/instrumentation/workflow", () => ({
  recordStepMetrics: vi.fn(),
}));
vi.mock("@/lib/features/plan-gate", () => ({
  checkActionPlanGate: vi.fn(() => Promise.resolve(null)),
}));
vi.mock("@/lib/workflow/executor/step-claim", () => ({
  acquireStepClaim: vi.fn(() => Promise.resolve({ outcome: "run" })),
  releaseStepClaim: vi.fn(() => Promise.resolve()),
  stepClaimScope: vi.fn((scope: unknown) => scope),
}));
vi.mock("@/lib/workflow/executor/logging", () => ({
  incrementCompletedSteps: vi.fn(),
  logStepCompleteDb: vi.fn(),
  logStepStartDb: vi.fn(),
  logWorkflowCompleteDb: vi.fn(),
  updateCurrentStep: vi.fn(),
}));

import {
  type AttributableRpcClient,
  noteRpcClient,
  noteRpcFailover,
  setRpcAttributionStorage,
} from "@/lib/rpc/engine/step-attribution";
import { RpcOrigin } from "@/lib/rpc/engine/types";
import {
  logStepCompleteDb,
  logStepStartDb,
} from "@/lib/workflow/executor/logging";
import {
  type StepContext,
  withStepLogging,
} from "@/lib/workflow/executor/step-handler";

const context: StepContext = {
  executionId: "exec-1",
  nodeId: "node-1",
  nodeName: "Read",
  nodeType: "web3/read-contract",
  organizationId: "org-1",
};

function client(
  origin: RpcOrigin,
  configId: string | null
): AttributableRpcClient {
  return { activeEndpoint: () => ({ origin, configId }) };
}

function persistedRpc(): unknown {
  return vi.mocked(logStepCompleteDb).mock.calls[0]?.[0]?.rpc;
}

beforeAll(() => {
  setRpcAttributionStorage(new AsyncLocalStorage());
});

describe("withStepLogging RPC attribution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(logStepStartDb).mockResolvedValue({
      logId: "log-1",
      startTime: Date.now(),
    });
  });

  it("writes the organization endpoint that served the step", async () => {
    await withStepLogging({ _context: context }, async () => {
      noteRpcClient(client(RpcOrigin.ORG, "cfg-1"));
      await Promise.resolve();
      return { success: true };
    });
    expect(persistedRpc()).toEqual({
      rpcOrigin: RpcOrigin.ORG,
      rpcConfigId: "cfg-1",
      rpcFailedOver: false,
    });
  });

  it("writes a failover on an errored step too", async () => {
    await withStepLogging({ _context: context }, async () => {
      noteRpcClient(client(RpcOrigin.PLATFORM, null));
      noteRpcFailover();
      await Promise.resolve();
      return { success: false, error: "reverted" };
    });
    const call = vi.mocked(logStepCompleteDb).mock.calls[0]?.[0];
    expect(call?.status).toBe("error");
    expect(call?.rpc).toEqual({
      rpcOrigin: RpcOrigin.PLATFORM,
      rpcConfigId: null,
      rpcFailedOver: true,
    });
  });

  it("writes the attribution when the step throws", async () => {
    await expect(
      withStepLogging({ _context: context }, async () => {
        noteRpcClient(client(RpcOrigin.ORG, "cfg-2"));
        await Promise.resolve();
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    expect(persistedRpc()).toMatchObject({ rpcConfigId: "cfg-2" });
  });

  it("writes nothing for a step that made no RPC call", async () => {
    await withStepLogging({ _context: context }, () =>
      Promise.resolve({ success: true })
    );
    expect(persistedRpc()).toBeNull();
  });

  it("does not carry one step's clients into the next", async () => {
    await withStepLogging({ _context: context }, async () => {
      noteRpcClient(client(RpcOrigin.ORG, "cfg-1"));
      await Promise.resolve();
      return { success: true };
    });
    await withStepLogging({ _context: context }, () =>
      Promise.resolve({ success: true })
    );
    expect(vi.mocked(logStepCompleteDb).mock.calls[1]?.[0]?.rpc).toBeNull();
  });
});
