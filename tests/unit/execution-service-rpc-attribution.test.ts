import { AsyncLocalStorage } from "node:async_hooks";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => {
  const where = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set }));
  return { set, update };
});

vi.mock("drizzle-orm", () => ({ eq: vi.fn(() => ({})) }));
vi.mock("@/lib/db", () => ({ db: { update: mocks.update } }));
vi.mock("@/lib/db/schema", () => ({
  directExecutions: { id: { name: "id" } },
}));
vi.mock("@/lib/web3/verify-receipt", () => ({
  verifyExecutionReceipts: vi.fn(),
  hasUnreadableReceipt: vi.fn(() => false),
  describeVerificationFailure: vi.fn(() => "verification failed"),
}));

import {
  completeExecution,
  failExecution,
} from "@/app/api/execute/_lib/execution-service";
import {
  noteRpcClient,
  runWithRpcAttribution,
  setRpcAttributionStorage,
} from "@/lib/rpc/engine/step-attribution";
import { RpcOrigin } from "@/lib/rpc/engine/types";

const orgClient = {
  activeEndpoint: () => ({ origin: RpcOrigin.ORG, configId: "cfg-1" }),
  manager: { isCurrentlyUsingFallback: () => false },
};

beforeAll(() => {
  setRpcAttributionStorage(new AsyncLocalStorage());
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("direct execution RPC attribution", () => {
  it("records the endpoint that served a completed execution", async () => {
    await runWithRpcAttribution(async () => {
      noteRpcClient(orgClient);
      await completeExecution("exec_1", { output: {} });
    });
    expect(mocks.set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "completed",
        rpcOrigin: RpcOrigin.ORG,
        rpcConfigId: "cfg-1",
        rpcFailedOver: false,
      })
    );
  });

  it("records it on a failed execution", async () => {
    await runWithRpcAttribution(async () => {
      noteRpcClient(orgClient);
      await failExecution("exec_1", "rpc down");
    });
    expect(mocks.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", rpcConfigId: "cfg-1" })
    );
  });

  it("leaves the columns alone when no RPC call was made", async () => {
    await runWithRpcAttribution(() => completeExecution("exec_1", {}));
    const written = (mocks.set.mock.calls[0] as unknown[])[0];
    expect(written).not.toHaveProperty("rpcOrigin");
  });
});
