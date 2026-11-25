import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/sleep", () => ({ sleep: vi.fn().mockResolvedValue(undefined) }));

const sinks = vi.hoisted(() => ({
  emitLogLine: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  recordError: vi.fn(),
}));
vi.mock("@/lib/log/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/log/core")>()),
  emitLogLine: sinks.emitLogLine,
}));
vi.mock("@sentry/nextjs", () => ({
  captureException: sinks.captureException,
  captureMessage: sinks.captureMessage,
}));
vi.mock("@/lib/metrics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/metrics")>()),
  getMetricsCollector: () => ({
    incrementCounter: vi.fn(),
    recordLatency: vi.fn(),
    recordError: sinks.recordError,
    setGauge: vi.fn(),
  }),
}));

import {
  ErrorCategory,
  logSystemError,
  logSystemWarn,
  logUserError,
} from "@/lib/logging";
import { isOrgRpcError, OrgRpcError } from "@/lib/rpc/engine/org-rpc-error";
import { RpcOrigin } from "@/lib/rpc/engine/types";
import { RpcProviderManager } from "@/lib/rpc/providers";
import { SolanaProviderManager } from "@/lib/rpc/providers/solana";

const down = (): Promise<never> => Promise.reject(new Error("down"));

function sinkCalls(): number {
  return Object.values(sinks).reduce(
    (sum, fn) => sum + fn.mock.calls.length,
    0
  );
}

describe("OrgRpcError", () => {
  it("is found in a cause chain", () => {
    const wrapped = new Error("step failed", {
      cause: new OrgRpcError("RPC failed on both endpoints"),
    });
    expect(isOrgRpcError(wrapped)).toBe(true);
    expect(isOrgRpcError(new Error("plain"))).toBe(false);
    expect(isOrgRpcError("text")).toBe(false);
  });
});

describe("platform logging gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("drops organization RPC failures from every platform sink", () => {
    const error = new Error("step failed", {
      cause: new OrgRpcError("RPC failed on both endpoints"),
    });

    logSystemError(ErrorCategory.NETWORK_RPC, "[Step] failed", error);
    logSystemWarn(ErrorCategory.NETWORK_RPC, "[Step] degraded", error);
    logUserError(ErrorCategory.NETWORK_RPC, "[Step] failed", error);

    expect(sinkCalls()).toBe(0);
  });

  it("still reports KeeperHub failures", () => {
    logSystemError(
      ErrorCategory.NETWORK_RPC,
      "[Step] failed",
      new Error("RPC failed on both endpoints")
    );

    expect(sinks.emitLogLine).toHaveBeenCalled();
    expect(sinks.captureException).toHaveBeenCalled();
    expect(sinks.recordError).toHaveBeenCalled();
  });
});

describe("manager failure ownership", () => {
  it("raises an OrgRpcError when an organization endpoint is in the route", async () => {
    const manager = new RpcProviderManager({
      config: {
        primaryRpcUrl: "https://org.example.com/key",
        fallbackRpcUrl: "https://kh.example.com/key",
        maxRetries: 1,
        failureOwner: RpcOrigin.ORG,
      },
    });
    const failure = await manager.executeWithFailover(down).catch((e) => e);
    expect(isOrgRpcError(failure)).toBe(true);
  });

  it("keeps a plain error for KeeperHub routes", async () => {
    const manager = new RpcProviderManager({
      config: { primaryRpcUrl: "https://kh.example.com/key", maxRetries: 1 },
    });
    const failure = await manager.executeWithFailover(down).catch((e) => e);
    expect(failure).toBeInstanceOf(Error);
    expect(isOrgRpcError(failure)).toBe(false);
  });

  it("does the same on Solana", async () => {
    const manager = new SolanaProviderManager({
      config: {
        primaryRpcUrl: "https://org.example.com/key",
        maxRetries: 1,
        failureOwner: RpcOrigin.ORG,
      },
    });
    const failure = await manager.executeWithFailover(down).catch((e) => e);
    expect(isOrgRpcError(failure)).toBe(true);
  });
});
